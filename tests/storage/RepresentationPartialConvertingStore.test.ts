import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Representation, RepresentationPreferences, ResourceIdentifier } from '@solid/community-server';
import { RepresentationMetadata } from '@solid/community-server';
import { RepresentationPartialConvertingStore } from '../../src/storage/RepresentationPartialConvertingStore';
import { AuthorityETagHandler } from '../../src/storage/AuthorityETagHandler';
import {
  computeDocumentVersion,
  readDocumentVersion,
  readDocumentVersionSuppressed,
  writeDocumentVersion,
} from '../../src/storage/rdf/DocumentVersion';

vi.mock('rdf-parse', () => ({
  default: {
    getContentTypes: vi.fn(async () => [ 'internal/quads', 'text/turtle', 'application/json' ]),
  },
}));

type MockConverterCallArgs = {
  identifier: ResourceIdentifier;
  representation: Representation;
  preferences: RepresentationPreferences;
};

const createRepresentation = (contentType: string): Representation => ({
  binary: false,
  metadata: { contentType },
  data: Readable.from(['dummy']),
} as unknown as Representation);

describe('RepresentationPartialConvertingStore', () => {
  const baseStore = {
    addResource: vi.fn(async () => ({})),
    setRepresentation: vi.fn(async () => ({})),
    getRepresentation: vi.fn(async () => createRepresentation('internal/quads')),
    deleteResource: vi.fn(async () => ({})),
  };

  const metadataStrategy = {
    isAuxiliaryIdentifier: vi.fn((identifier: ResourceIdentifier) =>
      identifier.path.endsWith('.acr') || identifier.path.endsWith('.acl')),
    getAuxiliaryIdentifier: vi.fn(),
    hasAuxiliaryIdentifier: vi.fn(),
    getAuxiliaryPath: vi.fn(),
  } as unknown;

  const createStore = () => {
    const inConverterCalls: MockConverterCallArgs[] = [];
    const outConverterCalls: MockConverterCallArgs[] = [];

    const inConverter = {
      canHandle: vi.fn(async () => undefined),
      handleSafe: vi.fn(async (args: MockConverterCallArgs) => {
        inConverterCalls.push(args);
        const converted = createRepresentation('internal/quads');
        converted.metadata = { contentType: 'internal/quads' } as any;
        converted.data = Readable.from(['converted quads']) as any;
        return converted;
      }),
    };

    const outConverter = {
      canHandle: vi.fn(async () => undefined),
      handleSafe: vi.fn(async (args: MockConverterCallArgs) => {
        outConverterCalls.push(args);
        const converted = createRepresentation('text/turtle');
        converted.metadata = { contentType: 'text/turtle' } as any;
        converted.data = Readable.from(['converted turtle']) as any;
        return converted;
      }),
    };

    const store = new RepresentationPartialConvertingStore(baseStore as any, metadataStrategy as any, {
      inConverter: inConverter as any,
      outConverter: outConverter as any,
      inPreferences: { type: { 'internal/quads': 1 } },
    });

    return {
      store,
      inConverter,
      outConverter,
      inConverterCalls,
      outConverterCalls,
    };
  };

  beforeEach(() => {
    baseStore.addResource.mockClear();
    baseStore.setRepresentation.mockClear();
    baseStore.getRepresentation.mockClear();
    baseStore.deleteResource.mockClear();
  });

  it('创建资源时会把 Turtle 转化为 internal/quads 再写入底层存储', async () => {
    const { store, inConverter } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/' } as ResourceIdentifier;
    const representation = createRepresentation('text/turtle');

    await store.addResource(identifier, representation);

    expect(inConverter.handleSafe).toHaveBeenCalledTimes(1);
    expect(baseStore.addResource).toHaveBeenCalledTimes(1);
    const converted = (baseStore.addResource.mock.calls as any)[0][1] as unknown as Representation;
    expect(converted.metadata?.contentType).toBe('internal/quads');
  });

  it('读取资源时根据偏好把 internal/quads 转换回 Turtle', async () => {
    const { store, outConverter } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/profile/card' } as ResourceIdentifier;

    const result = await store.getRepresentation(identifier, { type: { 'text/turtle': 1 } });

    expect(baseStore.getRepresentation).toHaveBeenCalledTimes(1);
    expect(outConverter.handleSafe).toHaveBeenCalledTimes(1);
    expect(result.metadata?.contentType).toBe('text/turtle');
  });

  it('更新辅助资源时会强制转换为 internal/quads', async () => {
    const { store, inConverter } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/profile/card.acr' } as ResourceIdentifier;
    const representation = createRepresentation('text/turtle');

    await store.setRepresentation(identifier, representation);

    expect(inConverter.handleSafe).toHaveBeenCalledTimes(1);
    expect(baseStore.setRepresentation).toHaveBeenCalledTimes(1);
    const converted = (baseStore.setRepresentation.mock.calls as any)[0][1] as unknown as Representation;
    expect(converted.metadata?.contentType).toBe('internal/quads');
  });

  it('删除资源会透传到底层存储', async () => {
    const { store } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/old.txt' } as ResourceIdentifier;

    await store.deleteResource(identifier);

    expect(baseStore.deleteResource).toHaveBeenCalledWith(identifier, undefined);
  });

  it('转换改变字节后以密封抑制指令取代原始 Turtle 版本，且不再回退秒级强校验器', async () => {
    const { store, outConverter } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/profile/card' } as ResourceIdentifier;
    const token = computeDocumentVersion({
      resourcePath: identifier.path,
      representationId: 'text/turtle',
      body: new TextEncoder().encode('a b c.'),
    });
    const sourceMetadata = new RepresentationMetadata({ path: identifier.path }, 'internal/quads');
    writeDocumentVersion(sourceMetadata, token);
    expect(readDocumentVersion(sourceMetadata)).toBe(token);
    baseStore.getRepresentation.mockImplementationOnce(async () => ({
      binary: false,
      metadata: sourceMetadata,
      data: Readable.from([ 'source quads' ]),
    } as unknown as Representation));

    outConverter.handleSafe.mockImplementationOnce(async () => ({
      binary: true,
      metadata: new RepresentationMetadata({ path: identifier.path }, 'text/turtle'),
      data: Readable.from([ 'converted turtle' ]),
    } as unknown as Representation));

    const result = await store.getRepresentation(identifier, { type: { 'text/turtle': 1 } });

    expect(outConverter.handleSafe).toHaveBeenCalledTimes(1);
    expect(readDocumentVersion(result.metadata)).toBeUndefined();
    expect(readDocumentVersionSuppressed(result.metadata)).toBe(true);
    // A converted surface must omit the ETag, not fall back to the seconds validator.
    expect(new AuthorityETagHandler().getETag(result.metadata)).toBeUndefined();
    expect(new AuthorityETagHandler().matchesETag(result.metadata, '"1700000000000-text/turtle"', false)).toBe(false);
  });

  it('转换后字节与 contentType 完全一致时保留原始强版本(默认协商 GET 不丢 ETag)', async () => {
    const { store, outConverter } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/profile/card.ttl' } as ResourceIdentifier;
    const body = new TextEncoder().encode('<x> <urn:p> <urn:o> .\n');
    const token = computeDocumentVersion({ resourcePath: identifier.path, representationId: 'text/turtle', body });
    const sourceMetadata = new RepresentationMetadata({ path: identifier.path }, 'text/turtle');
    writeDocumentVersion(sourceMetadata, token);
    baseStore.getRepresentation.mockImplementationOnce(async () => ({
      binary: true,
      metadata: sourceMetadata,
      data: Readable.from([ body ]),
    } as unknown as Representation));
    outConverter.handleSafe.mockImplementationOnce(async () => ({
      binary: true,
      metadata: new RepresentationMetadata({ path: identifier.path }, 'text/turtle'),
      data: Readable.from([ body ]),
    } as unknown as Representation));

    const result = await store.getRepresentation(identifier, { type: { '*/*': 1 } });

    expect(readDocumentVersionSuppressed(result.metadata)).toBe(false);
    expect(readDocumentVersion(result.metadata), 'an identity round-trip keeps the exact raw token').toBe(token);
    expect(new AuthorityETagHandler().getETag(result.metadata)).toBe(`"${token}"`);
  });

  it('转换产物流是 RDF quad 对象流时不做字节捕获、也不抛错，并省略校验器', async () => {
    const { store, outConverter } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/profile/card.ttl' } as ResourceIdentifier;
    const body = new TextEncoder().encode('<x> <urn:p> <urn:o> .\n');
    const token = computeDocumentVersion({ resourcePath: identifier.path, representationId: 'text/turtle', body });
    const sourceMetadata = new RepresentationMetadata({ path: identifier.path }, 'text/turtle');
    writeDocumentVersion(sourceMetadata, token);
    baseStore.getRepresentation.mockImplementationOnce(async () => ({
      binary: true,
      metadata: sourceMetadata,
      data: Readable.from([ body ]),
    } as unknown as Representation));

    // A quad (object-mode) converted stream carries Quads, not bytes: Buffer.from(Quad) must never run.
    const quad = { termType: 'Quad', value: '' };
    outConverter.handleSafe.mockImplementationOnce(async () => ({
      binary: false,
      metadata: new RepresentationMetadata({ path: identifier.path }, 'application/ld+json'),
      data: Readable.from([ quad ]),
    } as unknown as Representation));

    const result = await store.getRepresentation(identifier, { type: { 'application/ld+json': 1 } });

    expect(readDocumentVersion(result.metadata)).toBeUndefined();
    expect(readDocumentVersionSuppressed(result.metadata)).toBe(true);
    expect(new AuthorityETagHandler().getETag(result.metadata)).toBeUndefined();
    // The object stream is handed back untouched, not coerced through a byte buffer.
    const delivered: unknown[] = [];
    for await (const chunk of result.data as unknown as AsyncIterable<unknown>) {
      delivered.push(chunk);
    }
    expect(delivered).toEqual([ quad ]);
  });
});
