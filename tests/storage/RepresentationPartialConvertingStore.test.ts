import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Representation, RepresentationPreferences, ResourceIdentifier } from '@solid/community-server';
import { RepresentationPartialConvertingStore } from '../../src/storage/RepresentationPartialConvertingStore';

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
    isAuxiliaryIdentifier: vi.fn((identifier: ResourceIdentifier) => identifier.path.endsWith('.acr')),
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
        converted.data = Readable.from(['converted quads']);
        return converted;
      }),
    };

    const outConverter = {
      canHandle: vi.fn(async () => undefined),
      handleSafe: vi.fn(async (args: MockConverterCallArgs) => {
        outConverterCalls.push(args);
        const converted = createRepresentation('text/turtle');
        converted.metadata = { contentType: 'text/turtle' } as any;
        converted.data = Readable.from(['converted turtle']);
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
    const converted = baseStore.addResource.mock.calls[0][1] as Representation;
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
    const converted = baseStore.setRepresentation.mock.calls[0][1] as Representation;
    expect(converted.metadata?.contentType).toBe('internal/quads');
  });

  it('删除资源会透传到底层存储', async () => {
    const { store } = createStore();
    const identifier = { path: 'http://localhost:3000/alice/old.txt' } as ResourceIdentifier;

    await store.deleteResource(identifier);

    expect(baseStore.deleteResource).toHaveBeenCalledWith(identifier, undefined);
  });
});
