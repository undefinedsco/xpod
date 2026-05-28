import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import {
  ExtensionBasedMapper,
  FileDataAccessor,
  RepresentationMetadata,
  guardStream,
  LDP,
  RDF,
  NotFoundHttpError,
  BaseIdentifierStrategy,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { QuintStoreSparqlDataAccessor } from '../../../src/storage/accessors/QuintStoreSparqlDataAccessor';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { RdfQuadIndex, ShadowRdfQuintStore } from '../../../src/storage/rdf';
import { DisabledSparqlFeatureError } from '../../../src/storage/rdf';

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
  let structuredAccessor: QuintStoreSparqlDataAccessor;
  let structuredStore: SqliteQuintStore;
  let mapper: ExtensionBasedMapper;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'mix-accessor-'));
    dataDir = path.join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    mapper = new ExtensionBasedMapper(baseUrl, dataDir);
    const fileAccessor = new FileDataAccessor(mapper);
    const identifierStrategy = new SimpleIdentifierStrategy(baseUrl);
    structuredStore = new SqliteQuintStore({ path: path.join(workDir, 'quints.sqlite') });
    structuredAccessor = new QuintStoreSparqlDataAccessor(structuredStore, identifierStrategy);
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

  it('does not persist graph-scoped parser metadata in local RDF mirror metadata', async () => {
    const resourceId = { path: `${baseUrl}alice/profile/card.acr` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    metadata.addQuad(
      namedNode('http://www.w3.org/ns/auth/acl#'),
      namedNode('http://purl.org/vocab/vann/preferredNamespacePrefix'),
      literal('acl'),
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

  it('refreshes the local RDF mirror after SPARQL updates', async () => {
    const resourceId = { path: `${baseUrl}alice/patchable.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';

    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('before patch')
      )
    ])), metadata);

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    await accessor.executeSparqlUpdate(`
DELETE DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "before patch" . } };
INSERT DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "after patch" . } }
`.trim(), resourceId.path);

    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('after patch');
    expect(localRdf).not.toContain('before patch');

    const dataStream = await accessor.getData(resourceId);
    const resultQuads = await arrayifyStream(dataStream);
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].object.value).toBe('after patch');
  });

  it('applies supported SPARQL UPDATE directly to the local RDF authority file', async () => {
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
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "before embedded update" . } };
INSERT DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "after embedded update" . } }
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('after embedded update');
    expect(localRdf).not.toContain('before embedded update');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].object.value).toBe('after embedded update');
  });

  it('applies DELETE WHERE directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/delete-where.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('remove me')
      ),
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/description'),
        literal('keep me')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?name .
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).not.toContain('remove me');
    expect(localRdf).toContain('keep me');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].predicate.value).toBe('https://schema.org/description');
  });

  it('applies DELETE/INSERT WHERE directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/delete-insert-where.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('rewrite me')
      ),
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/description'),
        literal('keep me')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "rewritten directly" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('rewritten directly');
    expect(localRdf).toContain('keep me');
    expect(localRdf).not.toContain('rewrite me');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(2);
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual(['keep me', 'rewritten directly']);
  });

  it('applies INSERT WHERE directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/insert-where.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('first')
      ),
      quad(
        namedNode(`${resourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('second')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/description> "created directly" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?name .
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('first');
    expect(localRdf).toContain('second');
    expect(localRdf.match(/created directly/g)?.length).toBe(2);

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'created directly',
      'created directly',
      'first',
      'second',
    ]);
  });

  it('applies DELETE/INSERT WHERE with FILTER directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/filter-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('filter before')
      ),
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/description'),
        literal('keep me')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "filter after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
    FILTER(CONTAINS(STR(?old), "filter"))
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('filter after');
    expect(localRdf).toContain('keep me');
    expect(localRdf).not.toContain('filter before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual(['filter after', 'keep me']);
  });

  it('applies DELETE/INSERT WHERE with same-variable OR filters directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/or-filter-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    const thirdSubject = `${resourceId.path}#third`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('first before')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/name'),
        literal('second before')
      ),
      quad(
        namedNode(thirdSubject),
        namedNode('https://schema.org/name'),
        literal('third keep')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "or filter after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
    FILTER(?old = "first before" || ?old = "second before")
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('or filter after');
    expect(localRdf).toContain('third keep');
    expect(localRdf).not.toContain('first before');
    expect(localRdf).not.toContain('second before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'or filter after',
      'or filter after',
      'third keep',
    ]);
  });

  it('applies DELETE/INSERT WHERE with OPTIONAL anti-join directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/optional-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const taggedSubject = `${resourceId.path}#tagged`;
    const untaggedSubject = `${resourceId.path}#untagged`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(taggedSubject),
        namedNode('https://schema.org/name'),
        literal('tagged before')
      ),
      quad(
        namedNode(taggedSubject),
        namedNode('https://schema.org/tag'),
        literal('skip')
      ),
      quad(
        namedNode(untaggedSubject),
        namedNode('https://schema.org/name'),
        literal('untagged before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "untagged after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
    OPTIONAL { ?subject <https://schema.org/tag> ?tag . }
    FILTER(!BOUND(?tag))
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('tagged before');
    expect(localRdf).toContain('skip');
    expect(localRdf).toContain('untagged after');
    expect(localRdf).not.toContain('untagged before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual(['skip', 'tagged before', 'untagged after']);
  });

  it('applies DELETE/INSERT WHERE with VALUES directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/values-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('first before')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/name'),
        literal('second before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "first after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
  VALUES ?subject { <${firstSubject}> }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('first after');
    expect(localRdf).toContain('second before');
    expect(localRdf).not.toContain('first before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual(['first after', 'second before']);
  });

  it('applies DELETE/INSERT WHERE with UNION directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/union-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    const thirdSubject = `${resourceId.path}#third`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('first before')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/name'),
        literal('second before')
      ),
      quad(
        namedNode(thirdSubject),
        namedNode('https://schema.org/name'),
        literal('third keep')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "union after" .
  }
}
WHERE {
  {
    GRAPH <${resourceId.path}> {
      ?subject <https://schema.org/name> ?old .
      FILTER(?old = "first before")
    }
  }
  UNION
  {
    GRAPH <${resourceId.path}> {
      ?subject <https://schema.org/name> ?old .
      FILTER(?old = "second before")
    }
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('union after');
    expect(localRdf).toContain('third keep');
    expect(localRdf).not.toContain('first before');
    expect(localRdf).not.toContain('second before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'third keep',
      'union after',
      'union after',
    ]);
  });

  it('applies DELETE/INSERT WHERE with fixed-length property paths directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/path-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const thread = `${resourceId.path}#thread`;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      ),
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('first before')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/name'),
        literal('second before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "path after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    <${thread}> ^<https://schema.org/memberOf>/<https://schema.org/name> ?old .
    <${thread}> ^<https://schema.org/memberOf> ?subject .
    ?subject <https://schema.org/name> ?old .
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('path after');
    expect(localRdf).not.toContain('first before');
    expect(localRdf).not.toContain('second before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      thread,
      thread,
      'path after',
      'path after',
    ]);
  });

  it('applies DELETE/INSERT WHERE with MINUS directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/minus-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    const thread = `${resourceId.path}#thread`;
    const unread = `${resourceId.path}#unread`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      ),
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('already named')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> ?thread .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> <${unread}> .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> ?thread .
  }
  MINUS {
    GRAPH <${resourceId.path}> {
      ?subject <https://schema.org/name> ?name .
    }
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('already named');
    expect(localRdf).toContain('unread');
    expect(localRdf).toContain('thread');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => ({
      subject: quad.subject.value,
      predicate: quad.predicate.value,
      object: quad.object.value,
    })).sort((left, right) => `${left.subject}${left.predicate}${left.object}`.localeCompare(`${right.subject}${right.predicate}${right.object}`))).toEqual([
      {
        subject: firstSubject,
        predicate: 'https://schema.org/memberOf',
        object: thread,
      },
      {
        subject: firstSubject,
        predicate: 'https://schema.org/name',
        object: 'already named',
      },
      {
        subject: secondSubject,
        predicate: 'https://schema.org/memberOf',
        object: unread,
      },
    ]);
  });

  it('applies DELETE/INSERT WHERE with FILTER NOT EXISTS directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/not-exists-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    const thread = `${resourceId.path}#thread`;
    const unread = `${resourceId.path}#not-exists`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      ),
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('already named')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> ?thread .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> <${unread}> .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> ?thread .
  }
  FILTER NOT EXISTS {
    GRAPH <${resourceId.path}> {
      ?subject <https://schema.org/name> ?name .
    }
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('already named');
    expect(localRdf).toContain('not-exists');
    expect(localRdf).toContain('thread');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => ({
      subject: quad.subject.value,
      predicate: quad.predicate.value,
      object: quad.object.value,
    })).sort((left, right) => `${left.subject}${left.predicate}${left.object}`.localeCompare(`${right.subject}${right.predicate}${right.object}`))).toEqual([
      {
        subject: firstSubject,
        predicate: 'https://schema.org/memberOf',
        object: thread,
      },
      {
        subject: firstSubject,
        predicate: 'https://schema.org/name',
        object: 'already named',
      },
      {
        subject: secondSubject,
        predicate: 'https://schema.org/memberOf',
        object: unread,
      },
    ]);
  });

  it('applies DELETE/INSERT WHERE with FILTER EXISTS directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/exists-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    const thread = `${resourceId.path}#thread`;
    const unread = `${resourceId.path}#exists`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      ),
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('already named')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/memberOf'),
        namedNode(thread)
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> ?thread .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> <${unread}> .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/memberOf> ?thread .
  }
  FILTER EXISTS {
    GRAPH <${resourceId.path}> {
      ?subject <https://schema.org/name> ?name .
    }
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('already named');
    expect(localRdf).toContain('exists');
    expect(localRdf).toContain('thread');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => ({
      subject: quad.subject.value,
      predicate: quad.predicate.value,
      object: quad.object.value,
    })).sort((left, right) => `${left.subject}${left.predicate}${left.object}`.localeCompare(`${right.subject}${right.predicate}${right.object}`))).toEqual([
      {
        subject: firstSubject,
        predicate: 'https://schema.org/memberOf',
        object: unread,
      },
      {
        subject: firstSubject,
        predicate: 'https://schema.org/name',
        object: 'already named',
      },
      {
        subject: secondSubject,
        predicate: 'https://schema.org/memberOf',
        object: thread,
      },
    ]);
  });

  it('applies WITH-scoped DELETE/INSERT WHERE directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/with-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('first with before')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/name'),
        literal('second with before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
WITH <${resourceId.path}>
DELETE {
  ?subject <https://schema.org/name> ?old .
}
INSERT {
  ?subject <https://schema.org/name> "with after" .
}
WHERE {
  ?subject <https://schema.org/name> ?old .
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('with after');
    expect(localRdf).not.toContain('first with before');
    expect(localRdf).not.toContain('second with before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'with after',
      'with after',
    ]);
  });

  it('applies single-USING DELETE/INSERT WHERE directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/using-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    const firstSubject = `${resourceId.path}#first`;
    const secondSubject = `${resourceId.path}#second`;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(firstSubject),
        namedNode('https://schema.org/name'),
        literal('first using before')
      ),
      quad(
        namedNode(secondSubject),
        namedNode('https://schema.org/name'),
        literal('second using before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "using after" .
  }
}
USING <${resourceId.path}>
WHERE {
  ?subject <https://schema.org/name> ?old .
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('using after');
    expect(localRdf).not.toContain('first using before');
    expect(localRdf).not.toContain('second using before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'using after',
      'using after',
    ]);
  });

  it('falls back to the compatibility accessor for unsupported SPARQL UPDATE shapes', async () => {
    const resourceId = { path: `${baseUrl}alice/fallback-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('compatibility before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "compatibility after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
  GRAPH <https://external.example/data.ttl> {
    ?subject <https://schema.org/tag> ?tag .
  }
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).toHaveBeenCalledTimes(1);
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('compatibility before');
  });

  it('falls back for multi-USING updates that cannot be applied to one RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/multi-using-update.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/multi-using-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('multi using before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "multi using after" .
  }
}
USING <${resourceId.path}>
USING <${otherResourceId.path}>
WHERE {
  ?subject <https://schema.org/name> ?old .
}
`.trim(), resourceId.path);

    expect(compatibilityUpdateSpy).toHaveBeenCalledTimes(1);
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('multi using before');
    expect(localRdf).toContain('multi using after');
  });

  it('rejects SERVICE updates without forwarding them to the compatibility accessor', async () => {
    const resourceId = { path: `${baseUrl}alice/service-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('service before')
      )
    ])), metadata);
    const compatibilityUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await expect(accessor.executeSparqlUpdate(`
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "service after" .
  }
}
WHERE {
  SERVICE <https://remote.example/sparql> {
    ?subject <https://schema.org/name> ?old .
  }
}
`.trim(), resourceId.path)).rejects.toThrow(DisabledSparqlFeatureError);

    expect(compatibilityUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('service before');
    expect(localRdf).not.toContain('service after');
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

  it('refreshes source-scoped shadow RDF index without retaining stale file facts', async () => {
    const resourceId = { path: `${baseUrl}alice/source-scoped-file-authority.ttl` };
    const sourceIndex = new RdfQuadIndex({ path: ':memory:' });
    const sourceStore = new ShadowRdfQuintStore({
      compatibilityStore: structuredStore,
      index: sourceIndex,
    });
    const sourceAccessor = new QuintStoreSparqlDataAccessor(sourceStore as any, new SimpleIdentifierStrategy(baseUrl));
    const fileAccessor = new FileDataAccessor(mapper);
    const sourceScopedAccessor = new MixDataAccessor(sourceAccessor, fileAccessor);

    await sourceStore.open();
    try {
      await sourceScopedAccessor.syncLocalRdfDocument(
        resourceId,
        guardStream(Readable.from([ '<> <https://schema.org/name> "before source refresh" .\n' ])),
        'text/turtle',
        {
          workspace: `${baseUrl}alice/`,
          localPath: 'source-scoped-file-authority.ttl',
          sourceVersion: 'v1',
        },
      );
      await sourceScopedAccessor.syncLocalRdfDocument(
        resourceId,
        guardStream(Readable.from([ '<> <https://schema.org/name> "after source refresh" .\n' ])),
        'text/turtle',
        {
          workspace: `${baseUrl}alice/`,
          localPath: 'source-scoped-file-authority.ttl',
          sourceVersion: 'v2',
        },
      );

      const compatibilityQuads = await sourceStore.get({ graph: DataFactory.namedNode(resourceId.path) });
      expect(compatibilityQuads.map((quad) => quad.object.value)).toEqual(['after source refresh']);
      expect(sourceIndex.scan({ graph: DataFactory.namedNode(resourceId.path) }).quads.map((quad) => quad.object.value)).toEqual([
        'after source refresh',
      ]);
      expect(sourceIndex.stats()).toMatchObject({
        sourceCount: 1,
      });
    } finally {
      await sourceAccessor.finalize().catch(() => {});
    }
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
