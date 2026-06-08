import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { Readable } from 'stream';
import arrayifyStream from 'arrayify-stream';
import {
  BasicRepresentation,
  BadRequestHttpError,
  ForbiddenHttpError,
  NotImplementedHttpError,
  RepresentationMetadata,
  guardedStreamFrom,
  guardStream,
} from '@solid/community-server';
import { SparqlUpdateResourceStore } from '../../src/storage/SparqlUpdateResourceStore';
import { DisabledSparqlFeatureError, UnsupportedSparqlQueryError } from '../../src/storage/rdf';

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
    mockIdentifierStrategy.supportsIdentifier.mockReset().mockReturnValue(true);
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

  describe('default graph normalization', () => {
    it('does not short-circuit metadata resource PATCH away from the CSS metadata patcher', async () => {
      const metadataStrategy = {
        ...mockAuxiliaryStrategy,
        isAuxiliaryIdentifier: vi.fn(({ path }: { path: string }) => path.endsWith('.meta')),
      };
      store = new SparqlUpdateResourceStore({
        accessor: accessor as any,
        identifierStrategy: mockIdentifierStrategy as any,
        auxiliaryStrategy: mockAuxiliaryStrategy as any,
        metadataStrategy: metadataStrategy as any,
      });

      const metadataIdentifier = { path: 'http://localhost:3000/alice/agents/__secretary__/.meta' };
      const patch = createPatch(`
        INSERT DATA {
          <http://localhost:3000/alice/agents/__secretary__/> <https://undefineds.co/ns#runtimeKind> "codex" .
        }
      `);

      await expect(store.modifyResource(metadataIdentifier, patch)).rejects.toBeInstanceOf(NotImplementedHttpError);
      expect(accessor.executeSparqlUpdate).not.toHaveBeenCalled();
    });

    it('rejects explicit GRAPH targets outside the identifier space without falling back', async () => {
      mockIdentifierStrategy.supportsIdentifier.mockImplementation(({ path }) =>
        path.startsWith('http://localhost:3000/'));

      const identifier = { path: 'http://localhost:3000/alice/chat.ttl' };
      const patch = createPatch(`
        INSERT DATA {
          GRAPH <https://external.example/data.ttl> {
            <${identifier.path}#message> <https://schema.org/name> "bad" .
          }
        }
      `);

      await expect(store.modifyResource(identifier, patch)).rejects.toBeInstanceOf(BadRequestHttpError);
      expect(accessor.executeSparqlUpdate).not.toHaveBeenCalled();
    });

    it('rewrites DELETE WHERE default graph updates to the target resource graph', async () => {
      const identifier = { path: 'http://localhost:3000/alice/chat.ttl' };
      const patch = createPatch(`
        DELETE WHERE {
          <${identifier.path}#message> <https://schema.org/name> ?name .
        }
      `);

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];
      expect(executedQuery).toContain(`DELETE WHERE { GRAPH <${identifier.path}>`);
      expect(executedQuery).toContain(`<${identifier.path}#message> <https://schema.org/name> ?name`);
    });

    it('rewrites DELETE/INSERT WHERE default graph updates without generating invalid BGP templates', async () => {
      const identifier = { path: 'http://localhost:3000/alice/chat.ttl' };
      const patch = createPatch(`
        DELETE {
          <${identifier.path}#message> <https://schema.org/name> ?old .
        }
        INSERT {
          <${identifier.path}#message> <https://schema.org/name> "new" .
        }
        WHERE {
          <${identifier.path}#message> <https://schema.org/name> ?old .
        }
      `);

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];
      expect(executedQuery).toContain(`DELETE { GRAPH <${identifier.path}>`);
      expect(executedQuery).toContain(`INSERT { GRAPH <${identifier.path}>`);
      expect(executedQuery).toContain(`WHERE { GRAPH <${identifier.path}>`);
      expect(executedQuery).not.toContain('undefined');
    });

    it('preserves explicit GRAPH WHERE blocks and INSERT DATA operations', async () => {
      const identifier = { path: 'http://localhost:3000/alice/settings/credentials.ttl' };
      const subject = `${identifier.path}#cred-status-test`;
      const patch = createPatch(`
        DELETE {
          GRAPH <${identifier.path}> {
            <${subject}> <https://vocab.xpod.dev/credential#status> ?oldStatus .
          }
        }
        WHERE {
          GRAPH <${identifier.path}> {
            <${subject}> <https://vocab.xpod.dev/credential#status> ?oldStatus .
          }
        };
        INSERT DATA {
          GRAPH <${identifier.path}> {
            <${subject}> <https://vocab.xpod.dev/credential#status> "active" .
          }
        }
      `);

      await store.modifyResource(identifier, patch);

      expect(accessor.executeSparqlUpdate).toHaveBeenCalledTimes(1);
      const executedQuery = accessor.executeSparqlUpdate.mock.calls[0][0];
      expect(executedQuery).toContain(`WHERE { GRAPH <${identifier.path}>`);
      expect(executedQuery).not.toContain(`GRAPH <${identifier.path}> { GRAPH <${identifier.path}>`);
      expect(executedQuery).toContain('INSERT DATA');
      expect(executedQuery).not.toContain('WHERE {  }');
    });
  });

  describe('SPARQL engine errors', () => {
    it('maps unsupported RDF engine updates to 400 instead of leaking 500', async () => {
      accessor.executeSparqlUpdate.mockRejectedValueOnce(
        new UnsupportedSparqlQueryError('DELETE WHERE default graph fallback to compatibility engine'),
      );
      const identifier = { path: 'http://localhost:3000/alice/settings/credentials.ttl' };
      const patch = createPatch(`
        DELETE WHERE {
          <${identifier.path}#cred> <https://schema.org/name> ?name .
        }
      `);

      await expect(store.modifyResource(identifier, patch)).rejects.toBeInstanceOf(BadRequestHttpError);
    });

    it('maps disabled SPARQL features to 403 instead of leaking 500', async () => {
      accessor.executeSparqlUpdate.mockRejectedValueOnce(
        new DisabledSparqlFeatureError('SPARQL SERVICE federation is disabled for server-owned Pod queries'),
      );
      const identifier = { path: 'http://localhost:3000/alice/settings/credentials.ttl' };
      const patch = createPatch(`
        INSERT DATA {
          GRAPH <${identifier.path}> {
            <${identifier.path}#cred> <https://schema.org/name> "secret" .
          }
        }
      `);

      await expect(store.modifyResource(identifier, patch)).rejects.toBeInstanceOf(ForbiddenHttpError);
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
