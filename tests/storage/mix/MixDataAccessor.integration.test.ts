import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import {
  ExtensionBasedMapper,
  FileDataAccessor,
  type DataAccessor,
  RepresentationMetadata,
  guardStream,
  LDP,
  RDF,
  NotFoundHttpError,
  BaseIdentifierStrategy,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine, UnsupportedSparqlQueryError } from '../../../src/storage/rdf';
import { SqliteSolidFsSyncJournal } from '../../../src/solidfs';

type ResourceIdentifier = { path: string };

class SimpleIdentifierStrategy extends BaseIdentifierStrategy {
  public constructor(private baseUrl: string) {
    super();
    if (!this.baseUrl.endsWith('/')) {
      this.baseUrl = `${this.baseUrl}/`;
    }
  }

  public supportsIdentifier(identifier: ResourceIdentifier): boolean {
    return identifier.path.startsWith(this.baseUrl);
  }

  public isRootContainer(identifier: ResourceIdentifier): boolean {
    return identifier.path === this.baseUrl;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('MixDataAccessor (local profile integration)', () => {
  const baseUrl = 'http://localhost:3000/';
  let workDir: string;
  let dataDir: string;
  let accessor: MixDataAccessor;
  let structuredAccessor: SolidRdfDataAccessor;
  let rdfEngine: SolidRdfEngine;
  let mapper: ExtensionBasedMapper;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'mix-accessor-'));
    dataDir = path.join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    mapper = new ExtensionBasedMapper(baseUrl, dataDir);
    const fileAccessor = new FileDataAccessor(mapper);
    const identifierStrategy = new SimpleIdentifierStrategy(baseUrl);
    rdfEngine = new SolidRdfEngine({
      index: { path: path.join(workDir, 'rdf.sqlite') },
    });
    structuredAccessor = new SolidRdfDataAccessor(rdfEngine, identifierStrategy);
    accessor = new MixDataAccessor(structuredAccessor, fileAccessor);
  });

  afterEach(async () => {
    await structuredAccessor.finalize().catch(() => {});
    // The temp dir cleanup might fail if handles are open, but it's safer than crashing the app.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('crud operations use quadstore for containers and filesystem for unstructured files', async () => {
    const rootId = { path: baseUrl };
    const rootMetadata = new RepresentationMetadata(rootId);
    rootMetadata.contentType = 'internal/quads';
    rootMetadata.addQuad(rootMetadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
    rootMetadata.addQuad(rootMetadata.identifier, RDF.terms.type, LDP.terms.Container);
    rootMetadata.addQuad(rootMetadata.identifier, RDF.terms.type, LDP.terms.Resource);
    await accessor.writeContainer(rootId, rootMetadata);

    const containerPaths = [ `${baseUrl}alice/` ];
    for (const pathValue of containerPaths) {
      const containerId = { path: pathValue };
      const containerMetadata = new RepresentationMetadata(containerId);
      containerMetadata.contentType = 'internal/quads';
      containerMetadata.addQuad(containerMetadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
      containerMetadata.addQuad(containerMetadata.identifier, RDF.terms.type, LDP.terms.Container);
      containerMetadata.addQuad(containerMetadata.identifier, RDF.terms.type, LDP.terms.Resource);
      await accessor.writeContainer(containerId, containerMetadata);
      const storedMetadata = await accessor.getMetadata(containerId);
      expect(storedMetadata.contentType).toBe('internal/quads');
    }

    const jsonId = { path: `${baseUrl}alice/settings.json` };
    const jsonMetadata = new RepresentationMetadata(jsonId);
    jsonMetadata.contentType = 'application/json';
    const jsonPayload = Buffer.from(JSON.stringify({ theme: 'dark', lang: 'zh-CN' }));
    const jsonStream = guardStream(Readable.from([ jsonPayload ]));
    const jsonLink = await mapper.mapUrlToFilePath(jsonId as ResourceIdentifier, false, jsonMetadata.contentType);
    await mkdir(path.dirname(jsonLink.filePath), { recursive: true });
    await accessor.writeDocument(jsonId, jsonStream, jsonMetadata);

    const aliceChildren: string[] = [];
    for await (const child of accessor.getChildren({ path: `${baseUrl}alice/` })) {
      aliceChildren.push(child.identifier.value);
    }
    expect(aliceChildren).toContain(jsonId.path);

    // For unstructured files, metadata is stored in structuredAccessor with contentType
    // The MixDataAccessor should preserve the content type
    const jsonStoredMetadata = await accessor.getMetadata(jsonId);
    expect(jsonStoredMetadata).toBeDefined();
    expect(await fileExists(jsonLink.filePath)).toBe(true);

    const jsonData = await accessor.getData(jsonId);
    const jsonChunks = await arrayifyStream(jsonData as any);
    const jsonBuffer = Buffer.concat(jsonChunks.map((chunk: Buffer | Uint8Array) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    expect(jsonBuffer.toString('utf8')).toContain('"theme":"dark"');

    await accessor.deleteResource(jsonId);
    expect(await fileExists(jsonLink.filePath)).toBe(false);
    await expect(accessor.getMetadata(jsonId)).rejects.toBeInstanceOf(NotFoundHttpError);
    const aliceChildrenAfterDelete: string[] = [];
    for await (const child of accessor.getChildren({ path: `${baseUrl}alice/` })) {
      aliceChildrenAfterDelete.push(child.identifier.value);
    }
    expect(aliceChildrenAfterDelete).not.toContain(jsonId.path);

    for (const pathValue of containerPaths.slice().reverse()) {
      const containerId = { path: pathValue };
      await accessor.deleteResource(containerId);
      await expect(accessor.getMetadata(containerId)).rejects.toBeInstanceOf(NotFoundHttpError);
    }
  });

  it('should store RDF data via MixDataAccessor', async () => {
    const resourceId = { path: `${baseUrl}alice/data.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads'; // Simulate upstream conversion
    
    // Manually parse Turtle to Quads
    const { quad, namedNode } = DataFactory;
    const quads = [
      quad(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        namedNode('http://example.org/o')
      )
    ];
    const quadStream = guardStream(Readable.from(quads));
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');

    // 1. Write Quads data via MixDataAccessor (LDP PUT path)
    await accessor.writeDocument(resourceId, quadStream, metadata);

    // 2. RDF by-line resources must also exist as real local files for SolidFS/tools.
    expect(await fileExists(rdfLink.filePath)).toBe(true);
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('http://example.org/s');
    expect(localRdf).toContain('http://example.org/p');
    expect(localRdf).toContain('http://example.org/o');

    // 3. Read the data back via MixDataAccessor's structured path.
    const dataStream = await accessor.getData(resourceId);
    const resultQuads = await arrayifyStream(dataStream);

    // 4. Assert the structured index still has the RDF facts.
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].subject.value).toBe('http://example.org/s');
    expect(resultQuads[0].predicate.value).toBe('http://example.org/p');
    expect(resultQuads[0].object.value).toBe('http://example.org/o');

    await accessor.deleteResource(resourceId);
    expect(await fileExists(rdfLink.filePath)).toBe(false);
  });

  it('can index local RDF authority text into the RDF text search index', async () => {
    const textEngine = new SolidRdfEngine({
      index: { path: path.join(workDir, 'rdf-text.sqlite') },
      textIndex: { path: path.join(workDir, 'rdf-text-search.sqlite') },
    });
    const textStructuredAccessor = new SolidRdfDataAccessor(textEngine, new SimpleIdentifierStrategy(baseUrl));
    const intentSink = {
      recordTextCommitted: vi.fn(async () => {}),
      recordSourceDeleted: vi.fn(async () => {}),
    };
    const deleteVectorSource = vi.spyOn(textEngine, 'deleteVectorSource')
      .mockReturnValue(1);
    const textAccessor = new MixDataAccessor(
      textStructuredAccessor,
      new FileDataAccessor(mapper),
      false,
      true,
      new FileDataAccessor(mapper),
      true,
      undefined,
      undefined,
      intentSink,
    );
    const resourceId = { path: `${baseUrl}alice/searchable.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;

    try {
      await textAccessor.writeDocument(resourceId, guardStream(Readable.from([
        quad(
          namedNode(resourceId.path),
          namedNode('https://schema.org/name'),
          literal('searchable managed runtime note'),
        )
      ])), metadata);

      expect(textEngine.searchText({ query: 'managed runtime' })).toMatchObject([
        expect.objectContaining({
          source: resourceId.path,
          content: expect.stringContaining('managed runtime'),
        }),
      ]);
      expect(intentSink.recordTextCommitted).toHaveBeenCalledWith(expect.objectContaining({
        source: resourceId.path,
        workspace: `${baseUrl}alice/`,
        localPath: 'searchable.ttl',
        contentType: 'text/turtle',
        sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }));
      expect(deleteVectorSource).toHaveBeenCalledWith(resourceId.path);

      deleteVectorSource.mockClear();
      await textAccessor.writeDocument(resourceId, guardStream(Readable.from([
        quad(
          namedNode(resourceId.path),
          namedNode('https://schema.org/name'),
          literal('replacement content while embedding waits'),
        )
      ])), metadata);

      expect(deleteVectorSource).toHaveBeenCalledWith(resourceId.path);
      expect(intentSink.recordTextCommitted).toHaveBeenLastCalledWith(expect.objectContaining({
        source: resourceId.path,
        sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }));

      await textAccessor.deleteResource(resourceId);
      expect(textEngine.searchText({ query: 'managed runtime' })).toEqual([]);
      expect(intentSink.recordSourceDeleted).toHaveBeenCalledWith(resourceId.path);
    } finally {
      await textStructuredAccessor.finalize().catch(() => {});
    }
  });

  it('indexes ordinary Markdown writes after blob and metadata commit, then deletes text and vector indexes', async () => {
    const operations: string[] = [];
    const storedMetadata = new Map<string, RepresentationMetadata>();
    const structured = {
      writeRdfSourceDocument: vi.fn(),
      deleteRdfSourceDocument: vi.fn(),
      writeMetadata: vi.fn(async (identifier: ResourceIdentifier, metadata: RepresentationMetadata) => {
        operations.push('metadata');
        storedMetadata.set(identifier.path, new RepresentationMetadata(metadata));
      }),
      getMetadata: vi.fn(async (identifier: ResourceIdentifier) => {
        const metadata = storedMetadata.get(identifier.path);
        if (!metadata) {
          throw new NotFoundHttpError();
        }
        return new RepresentationMetadata(metadata);
      }),
      deleteResource: vi.fn(async (identifier: ResourceIdentifier) => {
        operations.push('metadata-delete');
        storedMetadata.delete(identifier.path);
      }),
      indexTextSource: vi.fn(async () => {
        operations.push('text-index');
      }),
      deleteTextSource: vi.fn(async () => {
        operations.push('text-delete');
        return 1;
      }),
      deleteVectorSource: vi.fn(async () => {
        operations.push('vector-delete');
        return 1;
      }),
    };
    const unstructured = {
      writeDocument: vi.fn(async (_identifier: ResourceIdentifier, data: Readable) => {
        operations.push('blob');
        const chunks = await arrayifyStream(data as any);
        expect(chunks.map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')).join('')).toContain('ordinary markdown body');
      }),
      deleteResource: vi.fn(async () => {
        operations.push('blob-delete');
      }),
    };
    const intentSink = {
      recordTextCommitted: vi.fn(async () => {
        operations.push('intent-commit');
      }),
      recordSourceDeleted: vi.fn(async () => {
        operations.push('intent-delete');
      }),
    };
    const textAccessor = new MixDataAccessor(
      structured as unknown as DataAccessor,
      unstructured as unknown as DataAccessor,
      false,
      true,
      unstructured as unknown as DataAccessor,
      true,
      undefined,
      undefined,
      intentSink,
    );
    const resourceId = { path: `${baseUrl}alice/ordinary.md` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'text/markdown';
    metadata.contentLength = Buffer.byteLength('# Heading\n\nordinary markdown body');

    await textAccessor.writeDocument(
      resourceId,
      guardStream(Readable.from([ '# Heading\n\nordinary markdown body' ])),
      metadata,
    );

    expect(operations).toEqual(['blob', 'metadata', 'vector-delete', 'text-index', 'intent-commit']);
    const expectedSourceHash = `sha256:${createHash('sha256').update('# Heading\n\nordinary markdown body').digest('hex')}`;
    expect(structured.indexTextSource).toHaveBeenCalledWith(
      expect.objectContaining({
        source: resourceId.path,
        workspace: `${baseUrl}alice/`,
        localPath: 'ordinary.md',
        contentType: 'text/markdown',
        sourceHash: expectedSourceHash,
      }),
      '# Heading\n\nordinary markdown body',
    );
    expect(intentSink.recordTextCommitted).toHaveBeenCalledWith(expect.objectContaining({
      source: resourceId.path,
      workspace: `${baseUrl}alice/`,
      localPath: 'ordinary.md',
      contentType: 'text/markdown',
      sourceHash: expectedSourceHash,
    }));

    await textAccessor.deleteResource(resourceId);

    expect(operations).toEqual([
      'blob',
      'metadata',
      'vector-delete',
      'text-index',
      'intent-commit',
      'blob-delete',
      'text-delete',
      'vector-delete',
      'intent-delete',
      'metadata-delete',
    ]);
    expect(structured.deleteTextSource).toHaveBeenCalledWith(resourceId.path);
    expect(structured.deleteVectorSource).toHaveBeenCalledWith(resourceId.path);
    expect(intentSink.recordSourceDeleted).toHaveBeenCalledWith(resourceId.path);
  });

  it('moves local RDF-owned text and vector index metadata with the RDF source', async () => {
    const operations: string[] = [];
    const structured = {
      writeRdfSourceDocument: vi.fn(),
      deleteRdfSourceDocument: vi.fn(),
      moveRdfSourceDocument: vi.fn(async () => {
        operations.push('rdf-move');
        return 2;
      }),
      indexTextSource: vi.fn(),
      moveTextSource: vi.fn(async () => {
        operations.push('text-move');
        return 1;
      }),
      deleteTextSource: vi.fn(),
      indexVectorSource: vi.fn(),
      moveVectorSource: vi.fn(async () => {
        operations.push('vector-move');
        return 1;
      }),
      deleteVectorSource: vi.fn(),
    };
    const unstructured = {};
    const intentSink = {
      recordTextCommitted: vi.fn(async () => {
        operations.push('intent-commit');
      }),
      recordSourceDeleted: vi.fn(),
    };
    const textAccessor = new MixDataAccessor(
      structured as unknown as DataAccessor,
      unstructured as unknown as DataAccessor,
      false,
      true,
      unstructured as unknown as DataAccessor,
      true,
      undefined,
      undefined,
      intentSink,
    );
    const previousId = { path: `${baseUrl}alice/docs/old.ttl` };
    const nextId = { path: `${baseUrl}alice/docs/new.ttl` };

    await expect(textAccessor.moveLocalRdfIndex(previousId, nextId, {
      sourceVersion: 'etag-new',
    })).resolves.toBe(2);

    const nextSource = {
      source: nextId.path,
      workspace: `${baseUrl}alice/docs/`,
      localPath: 'new.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'etag-new',
    };
    expect(operations).toEqual(['rdf-move', 'text-move', 'vector-move', 'intent-commit']);
    expect(structured.moveRdfSourceDocument).toHaveBeenCalledWith(previousId.path, nextSource);
    expect(structured.moveTextSource).toHaveBeenCalledWith(previousId.path, nextSource);
    expect(structured.moveVectorSource).toHaveBeenCalledWith(previousId.path, nextSource);
    expect(structured.deleteTextSource).not.toHaveBeenCalled();
    expect(structured.deleteVectorSource).not.toHaveBeenCalled();
    expect(intentSink.recordTextCommitted).toHaveBeenCalledWith(nextSource);
  });

  it('does not persist graph-scoped parser metadata in local RDF mirror metadata', async () => {
    const resourceId = { path: `${baseUrl}alice/profile/card.acr` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    metadata.addQuad(
      namedNode('http://www.w3.org/ns/solid/acp#'),
      namedNode('http://purl.org/vocab/vann/preferredNamespacePrefix'),
      literal('acp'),
      namedNode('urn:npm:solid:community-server:meta:ResponseMetadata'),
    );

    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#card`),
        namedNode('http://www.w3.org/ns/solid/acp#resource'),
        namedNode(`${baseUrl}alice/profile/card`),
      ),
    ])), metadata);

    const metaLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, true);
    expect(await fileExists(metaLink.filePath)).toBe(false);
  });

  it('fails closed when native QLever cannot prepare the authority update', async () => {
    const resourceId = { path: `${baseUrl}alice/embedded-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('before embedded update')
      )
    ])), metadata);
    await expect(accessor.executeSparqlUpdate(`
DELETE DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "before embedded update" . } };
INSERT DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "after embedded update" . } }
`.trim(), resourceId.path)).rejects.toMatchObject({
      code: 'qlever_runtime_unavailable',
    });

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('before embedded update');
    expect(localRdf).not.toContain('after embedded update');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].object.value).toBe('before embedded update');
  });

  it('commits a native prepared delta through the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/native-prepared-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const subject = namedNode(`${resourceId.path}#item`);
    const predicate = namedNode('https://schema.org/name');
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(subject, predicate, literal('before native update')),
    ])), metadata);
    const graph = namedNode(resourceId.path);
    const prepareSpy = vi.spyOn(structuredAccessor, 'prepareSparqlUpdate').mockResolvedValue({
      version: 1,
      graphs: [{
        graphIri: resourceId.path,
        sourceUri: resourceId.path,
        deletes: [quad(subject, predicate, literal('before native update'), graph)],
        inserts: [quad(subject, predicate, literal('after native update'), graph)],
      }],
    });
    const accessScope = {
      basePath: `${baseUrl}alice/`,
      mode: 'write' as const,
      allowedGraphUrls: [resourceId.path],
    };
    const signal = new AbortController().signal;

    await accessor.executeSparqlUpdate(
      'NATIVE PREPARED UPDATE',
      resourceId.path,
      accessScope,
      { timeoutMs: 2_500, signal },
    );

    expect(prepareSpy).toHaveBeenCalledWith(
      'NATIVE PREPARED UPDATE',
      resourceId.path,
      accessScope,
      { timeoutMs: 2_500, signal },
    );
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('after native update');
    expect(localRdf).not.toContain('before native update');
    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((item) => item.object.value)).toEqual(['after native update']);
  });

  it('rejects a native prepared graph whose source cannot preserve its graph identity', async () => {
    const sourceId = { path: `${baseUrl}alice/native-source-mismatch.ttl` };
    const graphIri = `${baseUrl}alice/different-graph.ttl`;
    const graph = DataFactory.namedNode(graphIri);
    vi.spyOn(structuredAccessor, 'prepareSparqlUpdate').mockResolvedValue({
      version: 1,
      graphs: [{
        graphIri,
        sourceUri: sourceId.path,
        deletes: [],
        inserts: [DataFactory.quad(
          DataFactory.namedNode(`${graphIri}#item`),
          DataFactory.namedNode('https://schema.org/name'),
          DataFactory.literal('must not be projected under another source'),
          graph,
        )],
      }],
    });

    await expect(accessor.executeSparqlUpdate('NATIVE PREPARED UPDATE', sourceId.path)).rejects.toBeInstanceOf(
      UnsupportedSparqlQueryError,
    );
  });

  it('rejects a native prepared delta for a graph denied by the current access scope', async () => {
    const allowed = `${baseUrl}alice/allowed.ttl`;
    const denied = `${baseUrl}alice/private/denied.ttl`;
    const deniedGraph = DataFactory.namedNode(denied);
    vi.spyOn(structuredAccessor, 'prepareSparqlUpdate').mockResolvedValue({
      version: 1,
      graphs: [{
        graphIri: denied,
        sourceUri: denied,
        deletes: [],
        inserts: [DataFactory.quad(
          DataFactory.namedNode(`${denied}#item`),
          DataFactory.namedNode('https://schema.org/name'),
          DataFactory.literal('must stay denied'),
          deniedGraph,
        )],
      }],
    });

    await expect(accessor.executeSparqlUpdate(
      'NATIVE PREPARED UPDATE',
      allowed,
      {
        basePath: `${baseUrl}alice/`,
        mode: 'write',
        deniedGraphPrefixes: [`${baseUrl}alice/private/`],
      },
    )).rejects.toThrow(/denied by the current access scope/i);

    await expect(accessor.getData({ path: denied })).rejects.toThrow();
  });

  it('rejects native prepared quads that do not belong to their declared graph', async () => {
    const source = `${baseUrl}alice/declared.ttl`;
    vi.spyOn(structuredAccessor, 'prepareSparqlUpdate').mockResolvedValue({
      version: 1,
      graphs: [{
        graphIri: source,
        sourceUri: source,
        deletes: [],
        inserts: [DataFactory.quad(
          DataFactory.namedNode(`${source}#item`),
          DataFactory.namedNode('https://schema.org/name'),
          DataFactory.literal('wrong graph'),
          DataFactory.namedNode(`${baseUrl}alice/other.ttl`),
        )],
      }],
    });

    await expect(accessor.executeSparqlUpdate(
      'NATIVE PREPARED UPDATE',
      source,
      {
        basePath: `${baseUrl}alice/`,
        mode: 'write',
      },
    )).rejects.toThrow(/outside its declared writable graph/i);
  });

  it('generates a missing local RDF mirror from the structured graph before file reads', async () => {
    const resourceId = { path: `${baseUrl}alice/generated.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';

    const { quad, namedNode, literal } = DataFactory;
    await structuredAccessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('generated from graph')
      )
    ])), metadata);
    const graphOnlyMetadata = new RepresentationMetadata(resourceId);
    graphOnlyMetadata.contentType = 'internal/quads';
    await structuredAccessor.writeMetadata(resourceId, graphOnlyMetadata);

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    expect(await fileExists(rdfLink.filePath)).toBe(false);

    const localDocument = await accessor.getLocalRdfDocument(resourceId);
    const localChunks = await arrayifyStream(localDocument.data as any);
    const localText = localChunks
      .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .join('');

    expect(localDocument.metadata.contentType).toBe('text/turtle');
    expect(localText).toContain('generated from graph');
    expect(await fileExists(rdfLink.filePath)).toBe(true);
    await expect(readFile(rdfLink.filePath, 'utf8')).resolves.toContain('generated from graph');
  });

  it('ignores legacy graph-shaped metadata sidecars when reading local RDF files', async () => {
    const resourceId = { path: `${baseUrl}alice/profile/card` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode } = DataFactory;

    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('http://xmlns.com/foaf/0.1/primaryTopic'),
        namedNode(`${resourceId.path}#me`)
      )
    ])), metadata);

    const metadataLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, true);
    await writeFile(
      metadataLink.filePath,
      `<urn:npm:solid:community-server:meta:ResponseMetadata> {
<http://xmlns.com/foaf/0.1/> <http://purl.org/vocab/vann/preferredNamespacePrefix> "foaf"
}
`,
      'utf8',
    );

    const localDocument = await accessor.getLocalRdfDocument(resourceId);
    const localChunks = await arrayifyStream(localDocument.data as any);
    const localText = localChunks
      .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .join('');

    expect(localDocument.metadata.contentType).toBe('text/turtle');
    expect(localText).toContain('primaryTopic');
  });

  it('writes local Turtle changes as file authority and refreshes the structured RDF index', async () => {
    const resourceId = { path: `${baseUrl}alice/file-authority.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;

    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('before file edit')
      )
    ])), metadata);

    await accessor.syncLocalRdfDocument(
      resourceId,
      guardStream(Readable.from([ '<> <https://schema.org/name> "after file edit" .\n' ])),
      'text/turtle',
    );

    const dataStream = await accessor.getData(resourceId);
    const resultQuads = await arrayifyStream(dataStream);
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].subject.value).toBe(resourceId.path);
    expect(resultQuads[0].object.value).toBe('after file edit');

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('after file edit');
    expect(localRdf).not.toContain('before file edit');
  });

  it('refreshes source-scoped SolidRdfEngine index without retaining stale file facts', async () => {
    const resourceId = { path: `${baseUrl}alice/source-scoped-file-authority.ttl` };
    await accessor.syncLocalRdfDocument(
      resourceId,
      guardStream(Readable.from([ '<> <https://schema.org/name> "before source refresh" .\n' ])),
      'text/turtle',
      {
        workspace: `${baseUrl}alice/`,
        localPath: 'source-scoped-file-authority.ttl',
        sourceVersion: 'v1',
      },
    );
    await accessor.syncLocalRdfDocument(
      resourceId,
      guardStream(Readable.from([ '<> <https://schema.org/name> "after source refresh" .\n' ])),
      'text/turtle',
      {
        workspace: `${baseUrl}alice/`,
        localPath: 'source-scoped-file-authority.ttl',
        sourceVersion: 'v2',
      },
    );

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value)).toEqual(['after source refresh']);
    expect(rdfEngine.scan({ pattern: { graph: DataFactory.namedNode(resourceId.path) } }).quads.map((quad) => quad.object.value)).toEqual([
      'after source refresh',
    ]);
    expect(rdfEngine.storageStats().facts).toMatchObject({
      sourceCount: 1,
    });
  });

  it('mirrors JSON-LD resources to the exact local jsonld path', async () => {
    const resourceId = { path: `${baseUrl}alice/data.jsonld` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';

    const { quad, namedNode, literal } = DataFactory;
    const quads = [
      quad(
        namedNode('http://example.org/jsonld-subject'),
        namedNode('http://example.org/name'),
        literal('JSON-LD local mirror')
      )
    ];
    const jsonldLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'application/ld+json');

    await accessor.writeDocument(resourceId, guardStream(Readable.from(quads)), metadata);

    expect(jsonldLink.filePath.endsWith('data.jsonld')).toBe(true);
    expect(await fileExists(jsonldLink.filePath)).toBe(true);
    expect(await fileExists(`${jsonldLink.filePath}$.ttl`)).toBe(false);
    const localJsonLd = await readFile(jsonldLink.filePath, 'utf8');
    expect(localJsonLd).toContain('"@id": "http://example.org/jsonld-subject"');
    expect(localJsonLd).toContain('JSON-LD local mirror');

    const dataStream = await accessor.getData(resourceId);
    const resultQuads = await arrayifyStream(dataStream);
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].subject.value).toBe('http://example.org/jsonld-subject');

    await accessor.deleteResource(resourceId);
    expect(await fileExists(jsonldLink.filePath)).toBe(false);
  });

  it('mirrors RDF/XML resources as standard RDF documents without marking them by-line', async () => {
    const resourceId = { path: `${baseUrl}alice/ontology.owl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';

    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode('http://example.org/rdfxml-subject'),
        namedNode('http://example.org/name'),
        literal('RDF XML local mirror')
      )
    ])), metadata);

    const rdfXmlLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'application/rdf+xml');
    expect(rdfXmlLink.filePath.endsWith('ontology.owl')).toBe(true);
    expect(await fileExists(rdfXmlLink.filePath)).toBe(true);
    const localRdfXml = await readFile(rdfXmlLink.filePath, 'utf8');
    expect(localRdfXml).toContain('rdf:RDF');
    expect(localRdfXml).toContain('RDF XML local mirror');

    await accessor.syncLocalRdfDocument(
      resourceId,
      guardStream(Readable.from([ `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:ex="http://example.org/">
  <rdf:Description rdf:about="http://example.org/rdfxml-subject">
    <ex:name>after rdfxml edit</ex:name>
  </rdf:Description>
</rdf:RDF>` ])),
      'application/rdf+xml',
    );

    const dataStream = await accessor.getData(resourceId);
    const resultQuads = await arrayifyStream(dataStream);
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].subject.value).toBe('http://example.org/rdfxml-subject');
    expect(resultQuads[0].object.value).toBe('after rdfxml edit');
    await expect(readFile(rdfXmlLink.filePath, 'utf8')).resolves.toContain('after rdfxml edit');
  });
});
