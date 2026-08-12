import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import {
  BaseIdentifierStrategy,
  guardStream,
  INTERNAL_QUADS,
  LDP,
  NotFoundHttpError,
  RDF,
  RepresentationMetadata,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { RdfQuadIndex, SolidRdfEngine, UnsupportedSparqlQueryError } from '../../src/storage/rdf';

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

describe('SolidRdfDataAccessor', () => {
  const baseUrl = 'http://localhost:3000/';
  let workDir: string;
  let engine: SolidRdfEngine;
  let accessor: SolidRdfDataAccessor;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'solid-rdf-accessor-'));
    engine = new SolidRdfEngine({
      index: new RdfQuadIndex({ path: path.join(workDir, 'rdf.sqlite') }),
    });
    accessor = new SolidRdfDataAccessor(engine, new SimpleIdentifierStrategy(baseUrl));
  });

  afterEach(async () => {
    await accessor.finalize().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes container metadata and parent containment without Comunica', async () => {
    const engineQuerySpy = vi.spyOn(engine, 'query');
    const root = { path: baseUrl };
    const rootMetadata = containerMetadata(root);
    await accessor.writeContainer(root, rootMetadata);

    const container = { path: `${baseUrl}alice/` };
    const metadata = containerMetadata(container);
    await accessor.writeContainer(container, metadata);

    const storedMetadata = await accessor.getMetadata(container);
    expect(storedMetadata.contentType).toBe(INTERNAL_QUADS);
    expect(storedMetadata.quads().some((value) =>
      value.subject.value === container.path &&
      value.predicate.equals(RDF.terms.type) &&
      value.object.equals(LDP.terms.Container)
    )).toBe(true);

    const rootChildren = [];
    for await (const child of accessor.getChildren(root)) {
      rootChildren.push(child.identifier.value);
    }
    expect(rootChildren).toEqual([container.path]);
    expect(engineQuerySpy).not.toHaveBeenCalled();
  });

  it('stores document data in the resource graph and metadata in meta graph', async () => {
    const id = { path: `${baseUrl}alice/data.ttl` };
    const metadata = new RepresentationMetadata(id);
    metadata.contentType = INTERNAL_QUADS;
    const { literal, namedNode, quad } = DataFactory;

    await accessor.writeDocument(id, guardStream(Readable.from([
      quad(namedNode(id.path), namedNode('https://schema.org/name'), literal('direct graph')),
    ])), metadata);

    const data = await arrayifyStream(await accessor.getData(id));
    expect(data.map((value) => value.graph.termType)).toEqual(['DefaultGraph']);
    expect(data.map((value) => value.object.value)).toEqual(['direct graph']);

    const resourceGraph = engine.scan({ pattern: { graph: namedNode(id.path) } }).quads;
    expect(resourceGraph).toHaveLength(1);
    expect(resourceGraph[0].object.value).toBe('direct graph');

    const metaGraph = engine.scan({ pattern: { graph: namedNode(`meta:${id.path}`) } }).quads;
    expect(metaGraph.length).toBeGreaterThan(0);
    expect(metaGraph.every((value) => value.graph.value === `meta:${id.path}`)).toBe(true);
  });

  it('replaces source-scoped RDF facts without keeping stale file quads', async () => {
    const id = { path: `${baseUrl}alice/source.ttl` };
    const metadata = new RepresentationMetadata(id);
    metadata.contentType = INTERNAL_QUADS;
    const { literal, namedNode, quad } = DataFactory;

    await accessor.writeRdfSourceDocument(id, [
      quad(namedNode(id.path), namedNode('https://schema.org/name'), literal('before')),
    ], metadata, {
      source: id.path,
      workspace: `${baseUrl}alice/`,
      localPath: 'source.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    });

    await accessor.writeRdfSourceDocument(id, [
      quad(namedNode(id.path), namedNode('https://schema.org/name'), literal('after')),
    ], metadata, {
      source: id.path,
      workspace: `${baseUrl}alice/`,
      localPath: 'source.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v2',
    });

    const data = await arrayifyStream(await accessor.getData(id));
    expect(data.map((value) => value.object.value)).toEqual(['after']);
    expect(engine.storageStats().facts.sourceCount).toBe(1);

    await accessor.deleteRdfSourceDocument(id);
    await expect(accessor.getMetadata(id)).rejects.toBeInstanceOf(NotFoundHttpError);
    expect(await arrayifyStream(await accessor.getData(id))).toHaveLength(0);
    expect(engine.storageStats().facts.sourceCount).toBe(0);
  });

  it('does not create an implicit RDF3X product index during initialization', async () => {
    const localEngine = new SolidRdfEngine({
      index: { path: path.join(workDir, 'derived-refresh.sqlite') },
    });
    const localAccessor = new SolidRdfDataAccessor(localEngine, new SimpleIdentifierStrategy(baseUrl));
    const { literal, namedNode, quad } = DataFactory;
    const graph = namedNode(`${baseUrl}alice/derived.ttl`);

    localEngine.open();
    localEngine.put([
      quad(namedNode(`${graph.value}#message`), namedNode('https://schema.org/name'), literal('refresh me'), graph),
      quad(namedNode(`${graph.value}#message`), namedNode('https://schema.org/dateCreated'), literal('2026-05-18'), graph),
    ]);

    expect(localEngine.storageStats().rdf3x).toBeUndefined();

    try {
      await localAccessor.initialize();

      expect(localEngine.storageStats().facts.quadCount).toBe(2);
      expect(localEngine.storageStats().rdf3x).toBeUndefined();
    } finally {
      await localAccessor.finalize().catch(() => {});
    }
  });

  it('prepares a native QLever update delta without mutating the RDF engine', async () => {
    const id = { path: `${baseUrl}alice/native-prepared.ttl` };
    const sparqlQuery = vi.fn().mockResolvedValue({
      status: 'ok',
      mediaType: 'application/vnd.xpod.rdf-prepared-delta+json;version=1',
      body: JSON.stringify({
        version: 1,
        graphs: [{
          graphIri: id.path,
          sourceUri: id.path,
          deletes: [{
            subject: { type: 'uri', value: `${id.path}#item` },
            predicate: { type: 'uri', value: 'https://schema.org/name' },
            object: { type: 'literal', value: 'before', datatype: 'http://www.w3.org/2001/XMLSchema#string' },
            graph: { type: 'uri', value: id.path },
          }],
          inserts: [{
            subject: { type: 'uri', value: `${id.path}#item` },
            predicate: { type: 'uri', value: 'https://schema.org/name' },
            object: { type: 'literal', value: 'after', 'xml:lang': 'en' },
            graph: { type: 'uri', value: id.path },
          }],
        }],
      }),
      profile: null,
      error: '',
    });
    const nativeAccessor = new SolidRdfDataAccessor({
      open: vi.fn(),
      close: vi.fn(),
      refreshDerivedIndexes: vi.fn(),
      sparqlQuery,
    } as any, new SimpleIdentifierStrategy(baseUrl));
    const controller = new AbortController();

    try {
      const delta = await nativeAccessor.prepareSparqlUpdate(
        'DELETE { ?s ?p ?o } INSERT { ?s ?p "after"@en } WHERE { ?s ?p ?o }',
        id.path,
        {
          basePath: id.path,
          mode: 'read',
          principal: 'https://id.example/alice#me',
        },
        { timeoutMs: 250, signal: controller.signal },
      );

      expect(delta?.version).toBe(1);
      expect(delta?.graphs).toHaveLength(1);
      expect(delta?.graphs[0]).toMatchObject({ graphIri: id.path, sourceUri: id.path });
      expect(delta?.graphs[0].deletes[0].object.value).toBe('before');
      expect(delta?.graphs[0].inserts[0].object).toMatchObject({ value: 'after', language: 'en' });
      expect(sparqlQuery).toHaveBeenCalledWith(expect.any(String), {
        basePath: id.path,
        sourceUri: id.path,
        operation: 'prepareUpdate',
        acceptMediaType: 'application/vnd.xpod.rdf-prepared-delta+json;version=1',
        accessScope: expect.objectContaining({
          basePath: id.path,
          mode: 'read',
          principal: 'https://id.example/alice#me',
        }),
        timeoutMs: 250,
        signal: controller.signal,
      });
    } finally {
      await nativeAccessor.finalize();
    }
  });

  it('fails closed when native QLever cannot prepare an update', async () => {
    const nativeAccessor = new SolidRdfDataAccessor({
      open: vi.fn(),
      close: vi.fn(),
      refreshDerivedIndexes: vi.fn(),
      sparqlQuery: vi.fn().mockResolvedValue({
        status: 'unsupported',
        mediaType: 'application/vnd.xpod.rdf-prepared-delta+json;version=1',
        body: '',
        error: 'blank-node mutation is not stable',
      }),
    } as any, new SimpleIdentifierStrategy(baseUrl));

    try {
      await expect(nativeAccessor.prepareSparqlUpdate(
        'INSERT DATA { _:item <urn:p> <urn:o> }',
        `${baseUrl}alice/native-unsupported.ttl`,
      )).rejects.toBeInstanceOf(UnsupportedSparqlQueryError);
    } finally {
      await nativeAccessor.finalize();
    }
  });

});

function containerMetadata(identifier: ResourceIdentifier): RepresentationMetadata {
  const metadata = new RepresentationMetadata(identifier);
  metadata.contentType = INTERNAL_QUADS;
  metadata.addQuad(metadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
  metadata.addQuad(metadata.identifier, RDF.terms.type, LDP.terms.Container);
  metadata.addQuad(metadata.identifier, RDF.terms.type, LDP.terms.Resource);
  return metadata;
}
