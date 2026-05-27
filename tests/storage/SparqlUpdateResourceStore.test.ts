import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { Readable } from 'stream';
import arrayifyStream from 'arrayify-stream';
import {
  BasicRepresentation,
  RepresentationMetadata,
  guardedStreamFrom,
  guardStream,
} from '@solid/community-server';
import { SparqlUpdateResourceStore } from '../../src/storage/SparqlUpdateResourceStore';

const { namedNode, literal } = DataFactory;

// Mock accessor with SPARQL capability
const createMockAccessor = () => ({
  executeSparqlUpdate: vi.fn().mockResolvedValue(undefined),
  getMetadata: vi.fn().mockResolvedValue(new RepresentationMetadata()),
  getData: vi.fn(),
  writeDocument: vi.fn(),
  writeContainer: vi.fn(),
  deleteResource: vi.fn(),
  canHandle: vi.fn().mockResolvedValue(undefined),
});

// Mock strategies
const mockIdentifierStrategy = {
  supportsIdentifier: vi.fn().mockReturnValue(true),
  getParentContainer: vi.fn().mockImplementation(({ path }) => ({ path: path.replace(/[^/]+\/?$/, '') })),
  isRootContainer: vi.fn().mockReturnValue(false),
};

const mockAuxiliaryStrategy = {
  isAuxiliaryIdentifier: vi.fn().mockReturnValue(false),
  getAuxiliaryIdentifiers: vi.fn().mockReturnValue([]),
  getAuxiliaryIdentifier: vi.fn(),
  getSubjectIdentifier: vi.fn(),
  addMetadata: vi.fn().mockResolvedValue(undefined),
  isRequiredInRoot: vi.fn().mockReturnValue(false),
  usesOwnAuthorization: vi.fn().mockReturnValue(false),
  validate: vi.fn(),
};

const createPatch = (sparql: string) => ({
  data: guardedStreamFrom(sparql),
  metadata: new RepresentationMetadata({ contentType: 'application/sparql-update' }),
  binary: true,
  isEmpty: false,
  algebra: {}, // Mark as SparqlUpdatePatch
});

describe('SparqlUpdateResourceStore', () => {
  let store: SparqlUpdateResourceStore;
  let accessor: ReturnType<typeof createMockAccessor>;

  beforeEach(() => {
    accessor = createMockAccessor();
    store = new SparqlUpdateResourceStore({
      accessor: accessor as any,
      identifierStrategy: mockIdentifierStrategy as any,
      auxiliaryStrategy: mockAuxiliaryStrategy as any,
      metadataStrategy: mockAuxiliaryStrategy as any,
    });
  });

  describe('literal handling in SPARQL UPDATE', () => {
    it('correctly serializes string literals with double quotes', async () => {
      const sparql = `
        DELETE DATA {
          <http://example.org/resource> <https://schema.org/name> "Alice Example" .
        };
        INSERT DATA {
          <http://example.org/resource> <https://schema.org/name> "Alice Updated" .
        }
      `;

      const patch = createPatch(sparql);
      const identifier = { path: 'http://localhost:3000/test/resource' };

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];

      // Should contain properly quoted literals, not IRIs
      expect(executedQuery).toContain('"Alice Example"');
      expect(executedQuery).toContain('"Alice Updated"');
      // Should NOT contain angle brackets around literal values
      expect(executedQuery).not.toContain('<Alice Example>');
      expect(executedQuery).not.toContain('<Alice Updated>');
    });

    it('correctly serializes integer literals', async () => {
      const sparql = `
        DELETE DATA {
          <http://example.org/resource> <https://schema.org/age> 30 .
        };
        INSERT DATA {
          <http://example.org/resource> <https://schema.org/age> 31 .
        }
      `;

      const patch = createPatch(sparql);
      const identifier = { path: 'http://localhost:3000/test/resource' };

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];

      // Integer literals should be quoted with datatype
      expect(executedQuery).toMatch(/"30"/);
      expect(executedQuery).toMatch(/"31"/);
      // Should NOT contain angle brackets around literal values
      expect(executedQuery).not.toContain('<30>');
      expect(executedQuery).not.toContain('<31>');
    });

    it('correctly serializes language-tagged literals', async () => {
      const sparql = `
        DELETE DATA {
          <http://example.org/resource> <http://www.w3.org/2000/01/rdf-schema#label> "Hello"@en .
        };
        INSERT DATA {
          <http://example.org/resource> <http://www.w3.org/2000/01/rdf-schema#label> "Bonjour"@fr .
        }
      `;

      const patch = createPatch(sparql);
      const identifier = { path: 'http://localhost:3000/test/resource' };

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];

      // Should preserve language tags
      expect(executedQuery).toMatch(/"Hello"@en/);
      expect(executedQuery).toMatch(/"Bonjour"@fr/);
    });

    it('correctly serializes datatyped literals', async () => {
      const sparql = `
        DELETE DATA {
          <http://example.org/resource> <https://schema.org/dateCreated> "2024-01-01"^^<http://www.w3.org/2001/XMLSchema#date> .
        };
        INSERT DATA {
          <http://example.org/resource> <https://schema.org/dateCreated> "2024-12-12"^^<http://www.w3.org/2001/XMLSchema#date> .
        }
      `;

      const patch = createPatch(sparql);
      const identifier = { path: 'http://localhost:3000/test/resource' };

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];

      // Should preserve datatypes
      expect(executedQuery).toMatch(/"2024-01-01"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#date>/);
      expect(executedQuery).toMatch(/"2024-12-12"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#date>/);
    });

    it('correctly handles mixed IRIs and literals', async () => {
      const sparql = `
        DELETE DATA {
          <http://example.org/resource> <https://schema.org/name> "Alice" .
          <http://example.org/resource> <https://schema.org/knows> <http://example.org/bob> .
        };
        INSERT DATA {
          <http://example.org/resource> <https://schema.org/name> "Alice Updated" .
          <http://example.org/resource> <https://schema.org/knows> <http://example.org/charlie> .
        }
      `;

      const patch = createPatch(sparql);
      const identifier = { path: 'http://localhost:3000/test/resource' };

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];

      // Literals should be quoted
      expect(executedQuery).toContain('"Alice"');
      expect(executedQuery).toContain('"Alice Updated"');
      // IRIs should have angle brackets
      expect(executedQuery).toContain('<http://example.org/bob>');
      expect(executedQuery).toContain('<http://example.org/charlie>');
    });
  });

  describe('local-first RDF reads', () => {
    it('delegates to the local-first RDF resolver before the normal store path', async () => {
      const identifier = { path: 'http://localhost:3000/alice/data.ttl' };
      const localMetadata = new RepresentationMetadata(identifier);
      localMetadata.contentType = 'text/turtle';
      const localData = guardStream(Readable.from([ '<#me> <https://schema.org/name> "Alice" .\n' ]));
      const localFirstRdfRepresentationResolver = {
        resolve: vi.fn().mockResolvedValue(new BasicRepresentation(localData, localMetadata)),
      };
      accessor = {
        ...createMockAccessor(),
        getData: vi.fn().mockRejectedValue(new Error('normal getData should not be used')),
      };
      store = new SparqlUpdateResourceStore({
        accessor: accessor as any,
        identifierStrategy: mockIdentifierStrategy as any,
        auxiliaryStrategy: mockAuxiliaryStrategy as any,
        metadataStrategy: mockAuxiliaryStrategy as any,
        localFirstRdfRepresentationResolver,
      });

      const representation = await store.getRepresentation(identifier);
      const chunks = await arrayifyStream(representation.data as any);
      const text = chunks
        .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        .join('');

      expect(localFirstRdfRepresentationResolver.resolve).toHaveBeenCalledWith(identifier);
      expect(accessor.getData).not.toHaveBeenCalled();
      expect(representation.metadata.contentType).toBe('text/turtle');
      expect(representation.binary).toBe(true);
      expect(text).toContain('Alice');
    });

    it('falls back to the normal store path when the local-first resolver does not resolve', async () => {
      const identifier = { path: 'http://localhost:3000/alice/photo.png' };
      const binaryMetadata = new RepresentationMetadata(identifier);
      binaryMetadata.contentType = 'image/png';
      const binaryData = guardStream(Readable.from([ Buffer.from('png') ]));
      const localFirstRdfRepresentationResolver = {
        resolve: vi.fn().mockResolvedValue(undefined),
      };
      accessor = {
        ...createMockAccessor(),
        getMetadata: vi.fn().mockResolvedValue(binaryMetadata),
        getData: vi.fn().mockResolvedValue(binaryData),
      };
      store = new SparqlUpdateResourceStore({
        accessor: accessor as any,
        identifierStrategy: mockIdentifierStrategy as any,
        auxiliaryStrategy: mockAuxiliaryStrategy as any,
        metadataStrategy: mockAuxiliaryStrategy as any,
        localFirstRdfRepresentationResolver,
      });

      const representation = await store.getRepresentation(identifier);

      expect(localFirstRdfRepresentationResolver.resolve).toHaveBeenCalledWith(identifier);
      expect(accessor.getData).toHaveBeenCalledWith(identifier);
      expect(representation.metadata.contentType).toBe('image/png');
    });
  });
});
