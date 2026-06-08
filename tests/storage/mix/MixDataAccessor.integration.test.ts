import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { DisabledSparqlFeatureError, SolidRdfEngine, UnsupportedSparqlQueryError } from '../../../src/storage/rdf';

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

  it('materializes resources created through SPARQL UPDATE on a missing RDF document', async () => {
    const resourceId = { path: `${baseUrl}alice/agents/__secretary__/profile/card` };

    await accessor.executeSparqlUpdate(`
INSERT DATA {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#me> <https://schema.org/name> "AI Secretary" .
  }
}
`.trim(), resourceId.path);

    await expect(accessor.getMetadata(resourceId)).resolves.toBeInstanceOf(RepresentationMetadata);
    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].subject.value).toBe(`${resourceId.path}#me`);
    expect(resultQuads[0].object.value).toBe('AI Secretary');

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('AI Secretary');
  });

  it('creates missing parent containers before writing nested unstructured documents', async () => {
    const resourceId = { path: `${baseUrl}alice/agents/__secretary__/skills/README.md` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'text/markdown';

    await accessor.writeDocument(
      resourceId,
      guardStream(Readable.from([ '# Skills\n' ])),
      metadata,
    );

    await expect(accessor.getMetadata(resourceId)).resolves.toBeInstanceOf(RepresentationMetadata);
    const fileLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, metadata.contentType);
    expect(await fileExists(fileLink.filePath)).toBe(true);
    expect(await readFile(fileLink.filePath, 'utf8')).toBe('# Skills\n');
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "before embedded update" . } };
INSERT DATA { GRAPH <${resourceId.path}> { <${resourceId.path}> <https://schema.org/name> "after embedded update" . } }
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?name .
  }
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).not.toContain('remove me');
    expect(localRdf).toContain('keep me');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].predicate.value).toBe('https://schema.org/description');
  });

  it('applies default graph DELETE WHERE directly to the exact local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/default-delete-where.ttl` };
    const siblingId = { path: `${baseUrl}alice/default-delete-where-sibling.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#message`),
        namedNode('https://schema.org/name'),
        literal('remove from exact graph')
      )
    ])), metadata);
    const siblingMetadata = new RepresentationMetadata(siblingId);
    siblingMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(siblingId, guardStream(Readable.from([
      quad(
        namedNode(`${siblingId.path}#message`),
        namedNode('https://schema.org/name'),
        literal('keep sibling graph')
      )
    ])), siblingMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE WHERE {
  <${resourceId.path}#message> <https://schema.org/name> ?name .
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(0);
    const siblingQuads = await arrayifyStream(await accessor.getData(siblingId));
    expect(siblingQuads.map((quad) => quad.object.value)).toEqual(['keep sibling graph']);
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('rewritten directly');
    expect(localRdf).toContain('keep me');
    expect(localRdf).not.toContain('rewrite me');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(2);
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual(['keep me', 'rewritten directly']);
  });

  it('applies explicit GRAPH WHERE plus INSERT DATA directly to the local RDF authority file', async () => {
    const resourceId = { path: `${baseUrl}alice/drizzle-style-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#cred`),
        namedNode('https://schema.org/name'),
        literal('before drizzle style update')
      )
    ])), metadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#cred> <https://schema.org/name> ?old .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#cred> <https://schema.org/name> ?old .
  }
};
INSERT DATA {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#cred> <https://schema.org/name> "after drizzle style update" .
  }
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].object.value).toBe('after drizzle style update');
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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

  it('rejects unsupported SPARQL UPDATE shapes without an implicit compatibility fallback', async () => {
    const resourceId = { path: `${baseUrl}alice/unsupported-external-graph-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(resourceId.path),
        namedNode('https://schema.org/name'),
        literal('unsupported before')
      )
    ])), metadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await expect(accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "unsupported after" .
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
`.trim(), resourceId.path)).rejects.toThrow(UnsupportedSparqlQueryError);

    expect(structuredUpdateSpy).toHaveBeenCalledTimes(1);
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('unsupported before');
    expect(localRdf).not.toContain('unsupported after');
  });

  it('applies multi-USING updates that read multiple RDF authority files and write one target file', async () => {
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
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('multi using other')
      )
    ])), otherMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('multi using before');
    expect(localRdf.match(/multi using after/g)?.length).toBe(2);

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('multi using other');
    expect(otherLocalRdf).not.toContain('multi using after');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'multi using after',
      'multi using after',
      'multi using before',
    ]);
  });

  it('applies negated string-filter updates to local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/negated-string-filter-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('keep before')
      ),
      quad(
        namedNode(`${resourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('skip before')
      )
    ])), metadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "negated string filter after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
  FILTER(!CONTAINS(STR(?old), "skip"))
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('negated string filter after');
    expect(localRdf).toContain('skip before');
    expect(localRdf).not.toContain('keep before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'negated string filter after',
      'skip before',
    ]);
  });

  it('applies negated term-test updates to local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/negated-term-test-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('term first')
      ),
      quad(
        namedNode(`${resourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('term second')
      )
    ])), metadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "negated term-test after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
  FILTER(!isNumeric(?old))
  FILTER(!sameTerm(?subject, <${resourceId.path}#second>))
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('negated term-test after');
    expect(localRdf).toContain('term second');
    expect(localRdf).not.toContain('term first');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'negated term-test after',
      'term second',
    ]);
  });

  it('applies negated LANGMATCHES updates to local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/negated-langmatches-update.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#untagged`),
        namedNode('https://schema.org/name'),
        literal('untagged before')
      ),
      quad(
        namedNode(`${resourceId.path}#english`),
        namedNode('https://schema.org/name'),
        literal('english before', 'en-US')
      ),
      quad(
        namedNode(`${resourceId.path}#french`),
        namedNode('https://schema.org/name'),
        literal('french before', 'fr')
      )
    ])), metadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> "negated langmatches after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/name> ?old .
  }
  FILTER(!LANGMATCHES(LANG(?old), "en"))
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('negated langmatches after');
    expect(localRdf).toContain('english before');
    expect(localRdf).not.toContain('untagged before');
    expect(localRdf).not.toContain('french before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value).sort()).toEqual([
      'english before',
      'negated langmatches after',
      'negated langmatches after',
    ]);
  });

  it('applies USING NAMED updates that read multiple RDF authority files and write one target file', async () => {
    const resourceId = { path: `${baseUrl}alice/using-named-update.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/using-named-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('using named target')
      )
    ])), metadata);
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('using named other')
      )
    ])), otherMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
INSERT {
  GRAPH <${resourceId.path}> {
    ?subject <https://schema.org/mentionsGraph> ?g .
  }
}
USING NAMED <${resourceId.path}>
USING NAMED <${otherResourceId.path}>
WHERE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain(resourceId.path);
    expect(localRdf).toContain(otherResourceId.path);

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('using named other');
    expect(otherLocalRdf).not.toContain('mentionsGraph');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => `${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`).sort()).toEqual([
      `${otherResourceId.path}#second https://schema.org/mentionsGraph ${otherResourceId.path}`,
      `${resourceId.path}#first https://schema.org/mentionsGraph ${resourceId.path}`,
      `${resourceId.path}#first https://schema.org/name using named target`,
    ]);
  });

  it('applies finite GRAPH variable updates to multiple local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/graph-variable-update.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/graph-variable-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('graph variable before')
      )
    ])), metadata);
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('graph variable other before')
      )
    ])), otherMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH ?g {
    ?subject <https://schema.org/name> "graph variable after" .
  }
}
USING NAMED <${resourceId.path}>
USING NAMED <${otherResourceId.path}>
WHERE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('graph variable after');
    expect(localRdf).not.toContain('graph variable before');

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('graph variable after');
    expect(otherLocalRdf).not.toContain('graph variable other before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value)).toEqual(['graph variable after']);
    const otherResultQuads = await arrayifyStream(await accessor.getData(otherResourceId));
    expect(otherResultQuads.map((quad) => quad.object.value)).toEqual(['graph variable after']);
  });

  it('applies explicit-filter GRAPH variable updates to multiple local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/graph-variable-filter-update.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/graph-variable-filter-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('graph variable filter before')
      )
    ])), metadata);
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('graph variable filter other before')
      )
    ])), otherMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH ?g {
    ?subject <https://schema.org/name> "graph variable filter after" .
  }
}
WHERE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
  FILTER(?g IN (<${resourceId.path}>, <${otherResourceId.path}>))
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('graph variable filter after');
    expect(localRdf).not.toContain('graph variable filter before');

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('graph variable filter after');
    expect(otherLocalRdf).not.toContain('graph variable filter other before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value)).toEqual(['graph variable filter after']);
    const otherResultQuads = await arrayifyStream(await accessor.getData(otherResourceId));
    expect(otherResultQuads.map((quad) => quad.object.value)).toEqual(['graph variable filter after']);
  });

  it('applies VALUES-constrained GRAPH variable updates to multiple local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/graph-variable-values-update.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/graph-variable-values-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('graph variable values before')
      )
    ])), metadata);
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('graph variable values other before')
      )
    ])), otherMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
}
INSERT {
  GRAPH ?g {
    ?subject <https://schema.org/name> "graph variable values after" .
  }
}
WHERE {
  GRAPH ?g {
    ?subject <https://schema.org/name> ?old .
  }
  VALUES (?g ?subject) {
    (<${resourceId.path}> <${resourceId.path}#first>)
    (<${otherResourceId.path}> <${otherResourceId.path}#second>)
  }
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('graph variable values after');
    expect(localRdf).not.toContain('graph variable values before');

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('graph variable values after');
    expect(otherLocalRdf).not.toContain('graph variable values other before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value)).toEqual(['graph variable values after']);
    const otherResultQuads = await arrayifyStream(await accessor.getData(otherResourceId));
    expect(otherResultQuads.map((quad) => quad.object.value)).toEqual(['graph variable values after']);
  });

  it('applies query-backed updates that write multiple local RDF authority files', async () => {
    const resourceId = { path: `${baseUrl}alice/multi-target-update.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/multi-target-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('multi target before')
      )
    ])), metadata);
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('multi target other before')
      )
    ])), otherMetadata);
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

    await accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#first> <https://schema.org/name> ?targetOld .
  }
  GRAPH <${otherResourceId.path}> {
    <${otherResourceId.path}#second> <https://schema.org/name> ?otherOld .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#first> <https://schema.org/name> "multi target after" .
  }
  GRAPH <${otherResourceId.path}> {
    <${otherResourceId.path}#second> <https://schema.org/name> "multi target other after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#first> <https://schema.org/name> ?targetOld .
  }
  GRAPH <${otherResourceId.path}> {
    <${otherResourceId.path}#second> <https://schema.org/name> ?otherOld .
  }
}
`.trim(), resourceId.path);

    expect(structuredUpdateSpy).not.toHaveBeenCalled();

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('multi target after');
    expect(localRdf).not.toContain('multi target before');

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('multi target other after');
    expect(otherLocalRdf).not.toContain('multi target other before');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value)).toEqual(['multi target after']);
    const otherResultQuads = await arrayifyStream(await accessor.getData(otherResourceId));
    expect(otherResultQuads.map((quad) => quad.object.value)).toEqual(['multi target other after']);
  });

  it('rolls back multi-target local RDF authority patches when index refresh fails', async () => {
    const resourceId = { path: `${baseUrl}alice/multi-target-rollback.ttl` };
    const otherResourceId = { path: `${baseUrl}alice/multi-target-rollback-other.ttl` };
    const metadata = new RepresentationMetadata(resourceId);
    metadata.contentType = 'internal/quads';
    const { quad, namedNode, literal } = DataFactory;
    await accessor.writeDocument(resourceId, guardStream(Readable.from([
      quad(
        namedNode(`${resourceId.path}#first`),
        namedNode('https://schema.org/name'),
        literal('rollback before')
      )
    ])), metadata);
    const otherMetadata = new RepresentationMetadata(otherResourceId);
    otherMetadata.contentType = 'internal/quads';
    await accessor.writeDocument(otherResourceId, guardStream(Readable.from([
      quad(
        namedNode(`${otherResourceId.path}#second`),
        namedNode('https://schema.org/name'),
        literal('rollback other before')
      )
    ])), otherMetadata);

    const originalWrite = structuredAccessor.writeRdfSourceDocument.bind(structuredAccessor);
    let writeCalls = 0;
    vi.spyOn(structuredAccessor, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
      writeCalls += 1;
      if (writeCalls === 2) {
        throw new Error('simulated index refresh failure');
      }
      return originalWrite(...args);
    });

    await expect(accessor.executeSparqlUpdate(`
DELETE {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#first> <https://schema.org/name> ?targetOld .
  }
  GRAPH <${otherResourceId.path}> {
    <${otherResourceId.path}#second> <https://schema.org/name> ?otherOld .
  }
}
INSERT {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#first> <https://schema.org/name> "rollback after" .
  }
  GRAPH <${otherResourceId.path}> {
    <${otherResourceId.path}#second> <https://schema.org/name> "rollback other after" .
  }
}
WHERE {
  GRAPH <${resourceId.path}> {
    <${resourceId.path}#first> <https://schema.org/name> ?targetOld .
  }
  GRAPH <${otherResourceId.path}> {
    <${otherResourceId.path}#second> <https://schema.org/name> ?otherOld .
  }
}
`.trim(), resourceId.path)).rejects.toThrow('simulated index refresh failure');

    const rdfLink = await mapper.mapUrlToFilePath(resourceId as ResourceIdentifier, false, 'text/turtle');
    const localRdf = await readFile(rdfLink.filePath, 'utf8');
    expect(localRdf).toContain('rollback before');
    expect(localRdf).not.toContain('rollback after');

    const otherRdfLink = await mapper.mapUrlToFilePath(otherResourceId as ResourceIdentifier, false, 'text/turtle');
    const otherLocalRdf = await readFile(otherRdfLink.filePath, 'utf8');
    expect(otherLocalRdf).toContain('rollback other before');
    expect(otherLocalRdf).not.toContain('rollback other after');

    const resultQuads = await arrayifyStream(await accessor.getData(resourceId));
    expect(resultQuads.map((quad) => quad.object.value)).toEqual(['rollback before']);
    const otherResultQuads = await arrayifyStream(await accessor.getData(otherResourceId));
    expect(otherResultQuads.map((quad) => quad.object.value)).toEqual(['rollback other before']);
    expect(writeCalls).toBeGreaterThanOrEqual(4);
  });

  it('rejects SERVICE updates before the structured accessor fallback path', async () => {
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
    const structuredUpdateSpy = vi.spyOn(structuredAccessor, 'executeSparqlUpdate');

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

    expect(structuredUpdateSpy).not.toHaveBeenCalled();
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
