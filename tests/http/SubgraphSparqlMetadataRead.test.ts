import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { DataFactory } from 'n3';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import type { HttpRequest, HttpResponse } from '@solid/community-server';
import { IdentifierSetMultiMap } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';

const { namedNode, literal } = DataFactory;

const BASE = 'http://localhost:3000/alice/';
const CONTAINER = `${BASE}agents/key/`;
const META = `meta:${CONTAINER}`;
const NAME = 'http://xmlns.com/foaf/0.1/name';

function binding(entries: Record<string, any>): Map<string, any> {
  return new Map(Object.entries(entries));
}

function streamOf(rows: Map<string, any>[]) {
  return {
    metadata: async () => ({ variables: [] }),
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () => index < rows.length
          ? { done: false, value: rows[index++] }
          : { done: true, value: undefined },
      };
    },
  };
}

function createRequest(url: string): HttpRequest {
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost:3000' },
    setEncoding: vi.fn(),
    on: vi.fn(),
  } as unknown as HttpRequest;
}

function createResponse(): HttpResponse & { bodyText(): string } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return Object.assign(writable, {
    statusCode: 200,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    removeHeader: vi.fn(),
    hasHeader: vi.fn(),
    headersSent: false,
    sendDate: true,
    getHeaderNames: vi.fn(() => []),
    getHeaders: vi.fn(() => ({})),
    flushHeaders: vi.fn(),
    writeHead: vi.fn(),
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  }) as unknown as HttpResponse & { bodyText(): string };
}

const sparql = (query: string): string => `/alice/-/sparql?query=${encodeURIComponent(query)}`;

describe('SubgraphSparqlHttpHandler explicit metadata reads', () => {
  const queryBindings = vi.fn();
  const queryQuads = vi.fn();
  const queryBoolean = vi.fn();
  const queryVoid = vi.fn();
  const listGraphs = vi.fn();
  const listMetadataGraphs = vi.fn();
  const constructGraph = vi.fn();
  const queryMetadataBindings = vi.fn();
  const credentialsExtractor = { handleSafe: vi.fn() };
  const permissionReader = { handleSafe: vi.fn(async () => new IdentifierSetMultiMap()) };
  const authorizer = { handleSafe: vi.fn() };
  let handler: SubgraphSparqlHttpHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    listGraphs.mockResolvedValue(new Set([ CONTAINER, META ]));
    listMetadataGraphs.mockResolvedValue(new Set([ META ]));
    queryMetadataBindings.mockResolvedValue(streamOf([]));
    credentialsExtractor.handleSafe.mockResolvedValue({ agent: { webId: 'https://id.example/alice#me' } });
    authorizer.handleSafe.mockResolvedValue(undefined);
    handler = new SubgraphSparqlHttpHandler(
      { queryBindings, queryQuads, queryBoolean, queryVoid, listGraphs, listMetadataGraphs, constructGraph, queryMetadataBindings } as any,
      credentialsExtractor as any,
      permissionReader as any,
      authorizer as any,
      {},
    );
  });

  it('routes an explicit metadata graph to the metadata engine base and returns the row', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({ resource: namedNode(CONTAINER), metadataGraph: namedNode(META), name: literal('Key Agent') }),
    ]));
    const response = createResponse();
    await handler.handle({
      request: createRequest(sparql(`SELECT ?name WHERE { GRAPH <${META}> { <${CONTAINER}> <${NAME}> ?name } }`)),
      response,
    });

    expect(queryMetadataBindings).toHaveBeenCalledWith(
      expect.stringContaining(`GRAPH <${META}>`),
      BASE,
      expect.objectContaining({ basePath: `meta:${BASE}`, mode: 'read' }),
    );
    expect(queryBindings).not.toHaveBeenCalled();
    expect(JSON.parse(response.bodyText()).results.bindings).toEqual([
      { resource: expect.objectContaining({ value: CONTAINER }), metadataGraph: expect.objectContaining({ value: META }), name: { type: 'literal', value: 'Key Agent' } },
    ]);
    expect(authorizer.handleSafe).toHaveBeenCalled();
    const checked = authorizer.handleSafe.mock.calls.map((call) => [ ...call[0].requestedModes.keys() ][0].path);
    expect(checked).toContain(CONTAINER);
  });

  it('drops an explicit metadata row when the subject ACL denies Read', async () => {
    authorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
      if ([ ...requestedModes.keys() ][0].path === CONTAINER) {
        throw new Error('denied');
      }
    });
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({ resource: namedNode(CONTAINER), metadataGraph: namedNode(META), name: literal('Secret') }),
    ]));
    const response = createResponse();
    await handler.handle({
      request: createRequest(sparql(`SELECT ?name WHERE { GRAPH <${META}> { <${CONTAINER}> <${NAME}> ?name } }`)),
      response,
    });
    expect(JSON.parse(response.bodyText()).results.bindings).toEqual([]);
  });

  it('rejects a metadata graph outside the endpoint base before querying the engine', async () => {
    const response = createResponse();
    await handler.handle({
      request: createRequest(sparql('SELECT ?name WHERE { GRAPH <meta:http://other.example/bob/> { ?s ?p ?name } }')),
      response,
    });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('outside');
    expect(queryMetadataBindings).not.toHaveBeenCalled();
  });

  it('rejects mixing un-named data patterns with metadata graphs', async () => {
    const response = createResponse();
    await handler.handle({
      request: createRequest(sparql(`SELECT ?s ?name WHERE { ?s <${NAME}> ?name GRAPH <${META}> { ?s ?p ?o } }`)),
      response,
    });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('metadata-only');
    expect(queryMetadataBindings).not.toHaveBeenCalled();
  });

  it('rejects a graph variable without the bounded metadata filter', async () => {
    queryBindings.mockResolvedValue(streamOf([]));
    const response = createResponse();
    await handler.handle({
      request: createRequest(sparql(`SELECT ?resource ?metadataGraph ?name WHERE { GRAPH ?metadataGraph { ?resource <${NAME}> ?name } }`)),
      response,
    });
    // Without a metadata signal this is an ordinary graph-variable query and keeps
    // today's data-namespace behavior rather than being reinterpreted as metadata.
    expect(queryMetadataBindings).not.toHaveBeenCalled();
  });

  it('requires the query-level graph<->subject binding filter', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([]));
    const response = createResponse();
    const query = `SELECT ?resource ?metadataGraph ?name WHERE { GRAPH ?metadataGraph { ?resource <${NAME}> ?name } FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}")) }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('STRAFTER');
    expect(queryMetadataBindings).not.toHaveBeenCalled();
  });

  it('returns only graph-subject-bound collection rows authorized for the subject', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({ resource: namedNode(CONTAINER), metadataGraph: namedNode(META), name: literal('Key Agent') }),
      // Mismatched graph/subject pair is not a valid facet binding.
      binding({ resource: namedNode(CONTAINER), metadataGraph: namedNode(`meta:${BASE}agents/other/`), name: literal('Leak') }),
    ]));
    const response = createResponse();
    const query = `SELECT ?resource ?metadataGraph ?name WHERE { GRAPH ?metadataGraph { ?resource <${NAME}> ?name } FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}")) FILTER(STR(?resource) = STRAFTER(STR(?metadataGraph), "meta:")) }`;
    await handler.handle({ request: createRequest(sparql(query)), response });

    expect(queryMetadataBindings).toHaveBeenCalledWith(
      query,
      BASE,
      expect.objectContaining({ basePath: `meta:${BASE}` }),
    );
    expect(JSON.parse(response.bodyText()).results.bindings.map((row: any) => row.name.value)).toEqual([ 'Key Agent' ]);
  });

  it('keeps ordinary un-named data queries on scopedUnion', async () => {
    queryBindings.mockResolvedValue(streamOf([]));
    const response = createResponse();
    await handler.handle({
      request: createRequest(sparql('SELECT ?s WHERE { ?s ?p ?o }')),
      response,
    });
    expect(queryMetadataBindings).not.toHaveBeenCalled();
    expect(queryBindings).toHaveBeenCalledWith(
      'SELECT ?s WHERE { ?s ?p ?o }',
      BASE,
      expect.anything(),
      expect.objectContaining({ defaultDataset: 'scopedUnion' }),
    );
  });
});
