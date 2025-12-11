import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { Representation, RepresentationPreferences, ResourceIdentifier } from '@solid/community-server';
import { RepresentationPartialConvertingStore } from '../../src/storage/RepresentationPartialConvertingStore';

const createRepresentation = (contentType: string): Representation => ({
  binary: true,
  metadata: { contentType },
  data: Readable.from(['dummy data']),
} as unknown as Representation);

describe('RepresentationPartialConvertingStore Conversion Coverage', () => {
  const baseStore = {
    addResource: vi.fn(async () => ({})),
    getRepresentation: vi.fn(async () => createRepresentation('internal/quads')),
    setRepresentation: vi.fn(async () => ({})),
  };

  const metadataStrategy = {
    isAuxiliaryIdentifier: vi.fn(() => false),
  } as unknown;

  // Mock inConverter that behaves like a real CSS converter chain
  const inConverter = {
    canHandle: vi.fn(async ({ representation }) => {
      const type = representation.metadata.contentType;
      const convertibleTypes = [
        'text/turtle',
        'application/ld+json',
        'application/n-triples',
        'application/trig',
        'application/n-quads',
        'text/n3',
        'internal/quads',
        'application/rdf+xml',
        // Polyglot
        'text/html',
        'application/xhtml+xml',
        'text/markdown',
        'application/xml'
      ];
      if (!convertibleTypes.includes(type)) {
        throw new Error(`Unsupported type: ${type}`);
      }
    }),
    handleSafe: vi.fn(async () => createRepresentation('internal/quads')),
  };

  const outConverter = {
    handleSafe: vi.fn(async () => createRepresentation('text/turtle')),
  };

  let store: RepresentationPartialConvertingStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RepresentationPartialConvertingStore(baseStore as any, metadataStrategy as any, {
      inConverter: inConverter as any,
      outConverter: outConverter as any,
      inPreferences: { type: { 'internal/quads': 1 } },
    });
  });

  // Group 1: Pure RDF - MUST Convert
  const rdfTypes = [
    'text/turtle',
    'application/ld+json',
    'application/n-triples',
    'application/trig',
    'application/n-quads',
    'text/n3',
    'internal/quads'
  ];

  rdfTypes.forEach(type => {
    it(`should convert Pure RDF type ${type} to internal/quads`, async () => {
      const identifier = { path: 'http://example.org/resource' };
      const representation = createRepresentation(type);

      await store.addResource(identifier, representation);

      expect(inConverter.canHandle).toHaveBeenCalled();
      expect(inConverter.handleSafe).toHaveBeenCalledTimes(1);
      expect(baseStore.addResource).toHaveBeenCalledTimes(1);
    });
  });

  // Group 2: Polyglot Documents - MUST NOT Convert (Not in Whitelist)
  const nonWhitelistedTypes = [
    'text/html',
    'application/xhtml+xml',
    'text/markdown',
    'application/xml',
    'application/json'
  ];

  nonWhitelistedTypes.forEach(type => {
    it(`should NOT convert Non-Whitelisted type ${type} (Preserve File)`, async () => {
      const identifier = { path: 'http://example.org/resource' };
      const representation = createRepresentation(type);

      await store.addResource(identifier, representation);

      expect(inConverter.canHandle).not.toHaveBeenCalled();
      expect(inConverter.handleSafe).not.toHaveBeenCalled();
      expect(baseStore.addResource).toHaveBeenCalledTimes(1);
    });
  });

  // Group 3: Pure Binary - MUST NOT Convert (Not in Whitelist)
  const binaryTypes = [
    'text/plain',
    'image/png',
    'application/octet-stream',
    'video/mp4'
  ];

  binaryTypes.forEach(type => {
    it(`should NOT convert Binary type ${type} (Not in Whitelist)`, async () => {
      const identifier = { path: 'http://example.org/resource' };
      const representation = createRepresentation(type);

      await store.addResource(identifier, representation);

      expect(inConverter.canHandle).not.toHaveBeenCalled();
      expect(inConverter.handleSafe).not.toHaveBeenCalled();
      expect(baseStore.addResource).toHaveBeenCalledTimes(1);
    });
  });
});
