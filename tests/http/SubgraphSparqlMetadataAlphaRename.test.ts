import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { DataFactory } from 'n3';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import type { HttpRequest, HttpResponse } from '@solid/community-server';
import { IdentifierSetMultiMap } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';

const { namedNode, literal } = DataFactory;

const BASE = 'http://localhost:3000/alice/agents/';
const SUBJECT = `${BASE}key/`;
const META = `meta:${SUBJECT}`;
const NAME = 'http://xmlns.com/foaf/0.1/name';
const CREATED = 'http://purl.org/dc/terms/created';

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
    statusCode: 200, setHeader: vi.fn(), getHeader: vi.fn(), removeHeader: vi.fn(),
    hasHeader: vi.fn(), headersSent: false, sendDate: true, getHeaderNames: vi.fn(() => []),
    getHeaders: vi.fn(() => ({})), flushHeaders: vi.fn(), writeHead: vi.fn(),
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  }) as unknown as HttpResponse & { bodyText(): string };
}

const sparql = (query: string): string => `/alice/agents/-/sparql?query=${encodeURIComponent(query)}`;

describe('SubgraphSparqlHttpHandler metadata variable-name independence', () => {
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
    listGraphs.mockResolvedValue(new Set([ META ]));
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

  it('accepts arbitrary subject/graph variable names and returns them unchanged', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({
        agent: namedNode(SUBJECT),
        g: namedNode(META),
        label: literal('Key Agent'),
        created: literal('2026-11-17T00:00:00.000Z'),
      }),
    ]));
    const response = createResponse();
    const query = `SELECT ?agent ?g ?label ?created WHERE {
      GRAPH ?g { ?agent <${NAME}> ?label ; <${CREATED}> ?created }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
      FILTER(STR(?agent) = STRAFTER(STR(?g), "meta:"))
    } ORDER BY ?created LIMIT 1`;
    await handler.handle({ request: createRequest(sparql(query)), response });

    const payload = JSON.parse(response.bodyText());
    expect(payload.results.bindings).toHaveLength(1);
    expect(payload.results.bindings[0]).toMatchObject({
      agent: { value: SUBJECT },
      g: { value: META },
      label: { value: 'Key Agent' },
    });
    expect(queryMetadataBindings).toHaveBeenCalledWith(query, BASE, expect.objectContaining({ basePath: `meta:${BASE}` }));
  });

  it('accepts the BIND(IRI(CONCAT(...))) + term-equality binding form', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({ subject: namedNode(SUBJECT), metadataGraph: namedNode(META), name: literal('Bound Agent') }),
    ]));
    const response = createResponse();
    const query = `SELECT ?subject ?metadataGraph ?name WHERE {
      GRAPH ?metadataGraph { ?subject <${NAME}> ?name }
      FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}"))
      BIND(IRI(CONCAT("meta:", STR(?subject))) AS ?expected)
      FILTER(?metadataGraph = ?expected)
    } ORDER BY ?name LIMIT 1`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode, response.bodyText()).toBe(200);
    expect(JSON.parse(response.bodyText()).results.bindings).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ value: SUBJECT }) }),
    ]);
  });

  it('rejects a collection query without the structural graph<->subject binding', async () => {
    const response = createResponse();
    const query = `SELECT ?agent ?g ?label WHERE {
      GRAPH ?g { ?agent <${NAME}> ?label }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
    }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('STRAFTER');
    expect(queryMetadataBindings).not.toHaveBeenCalled();
  });

  it('accepts a grouped aggregate that projects neither graph nor subject', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({ label: literal('Dup'), total: literal('2') }),
      binding({ label: literal('Solo'), total: literal('1') }),
    ]));
    const response = createResponse();
    // SPARQL forbids projecting ungrouped variables, so the aggregate shape must
    // not require ?agent/?g while still carrying the ownership correlation.
    const query = `SELECT ?label (COUNT(?label) AS ?total) WHERE {
      GRAPH ?g { ?agent <${NAME}> ?label }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
      FILTER(STR(?agent) = STRAFTER(STR(?g), "meta:"))
    } GROUP BY ?label`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode, response.bodyText()).toBe(200);
    const payload = JSON.parse(response.bodyText());
    expect(payload.results.bindings.map((row: any) => [ row.label.value, row.total.value ])).toEqual([
      [ 'Dup', '2' ],
      [ 'Solo', '1' ],
    ]);
  });

  it('still rejects a collection query without the ownership correlation', async () => {
    const response = createResponse();
    const query = `SELECT ?label (COUNT(?label) AS ?total) WHERE {
      GRAPH ?g { ?agent <${NAME}> ?label }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
    } GROUP BY ?label`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('STRAFTER');
  });

  it('returns 200 empty for an exact metadata graph that was never written', async () => {
    listMetadataGraphs.mockResolvedValue(new Set());
    queryMetadataBindings.mockResolvedValue(streamOf([]));
    const missing = `meta:${BASE}missing/`;
    const response = createResponse();
    const query = `SELECT ?label WHERE { GRAPH <${missing}> { <${BASE}missing/> <${NAME}> ?label } }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode, response.bodyText()).toBe(200);
    expect(JSON.parse(response.bodyText()).results.bindings).toEqual([]);
    // Nothing to authorize and nothing to query: fail closed as an empty range.
    expect(queryMetadataBindings).not.toHaveBeenCalled();
  });

  it('keeps exact GRAPH reads valid without any projected subject variable', async () => {
    queryMetadataBindings.mockResolvedValue(streamOf([
      binding({ g: namedNode(META), label: literal('Key Agent') }),
    ]));
    const response = createResponse();
    const query = `SELECT ?label WHERE { GRAPH <${META}> { <${SUBJECT}> <${NAME}> ?label } }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    const payload = JSON.parse(response.bodyText());
    expect(payload.results.bindings).toEqual([ { g: { type: 'uri', value: META }, label: { type: 'literal', value: 'Key Agent' } } ]);
  });

  it('pins the collection physical scope to the authorized snapshot and fails closed when empty', async () => {
    const query = `SELECT ?agent ?g ?label WHERE {
      GRAPH ?g { ?agent <${NAME}> ?label }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
      FILTER(STR(?agent) = STRAFTER(STR(?g), "meta:"))
    }`;
    queryMetadataBindings.mockResolvedValue(streamOf([]));

    const response = createResponse();
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(queryMetadataBindings).toHaveBeenCalledWith(
      query,
      BASE,
      expect.objectContaining({
        basePath: `meta:${BASE}`,
        allowedGraphUrls: [ META ],
      }),
    );

    listMetadataGraphs.mockResolvedValue(new Set());
    queryMetadataBindings.mockClear();
    const empty = createResponse();
    await handler.handle({ request: createRequest(sparql(query)), response: empty });
    expect(queryMetadataBindings).not.toHaveBeenCalled();
    expect(empty.statusCode, empty.bodyText()).toBe(200);
    expect(JSON.parse(empty.bodyText()).results.bindings).toEqual([]);
  });

  it('drops a graph created after authorization without exposing its row', async () => {
    const lateGraph = `meta:${BASE}late/`;
    listMetadataGraphs.mockResolvedValue(new Set([ META, lateGraph ]));
    authorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
      if ([ ...requestedModes.keys() ][0].path === `${BASE}late/`) {
        throw new Error('late denied');
      }
    });
    // The engine respects the finite allow-list, so the late row is absent before LIMIT.
    queryMetadataBindings.mockImplementation(async (_q: string, _b: string, scope: any) => {
      const allowed = new Set(scope.allowedGraphUrls);
      const rows = [
        binding({ agent: namedNode(SUBJECT), g: namedNode(META), label: literal('Authorized') }),
        binding({ agent: namedNode(`${BASE}late/`), g: namedNode(lateGraph), label: literal('Late') }),
      ].filter((row) => allowed.has(row.get('g')!.value));
      return streamOf(rows);
    });
    const response = createResponse();
    const query = `SELECT ?agent ?g ?label WHERE {
      GRAPH ?g { ?agent <${NAME}> ?label }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
      FILTER(STR(?agent) = STRAFTER(STR(?g), "meta:"))
    } ORDER BY ?label LIMIT 1`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    const payload = JSON.parse(response.bodyText());
    expect(payload.results.bindings.map((row: any) => row.label.value)).toEqual([ 'Authorized' ]);
  });

  it('leaves ordinary non-metadata graph patterns on the data path, including nested GRAPH shapes', async () => {
    queryBindings.mockResolvedValue(streamOf([]));
    const response = createResponse();
    // Ordinary /g query: not a metadata signal, so the metadata classifier must not reject it.
    const query = `SELECT ?s WHERE { GRAPH ?g { ?s <${NAME}> ?o } }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode).toBe(200);
    expect(queryMetadataBindings).not.toHaveBeenCalled();
    expect(queryBindings).toHaveBeenCalled();
  });

  it('rejects mixed data and metadata graph patterns', async () => {
    const response = createResponse();
    const query = `SELECT ?agent ?g ?label WHERE {
      ?doc <${NAME}> ?label
      GRAPH ?g { ?agent <${NAME}> ?label }
      FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
    }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('metadata-only');
  });

  it('rejects a metadata graph outside the endpoint base', async () => {
    const response = createResponse();
    const query = `SELECT ?label WHERE { GRAPH <meta:http://other.example/bob/> { ?s <${NAME}> ?label } }`;
    await handler.handle({ request: createRequest(sparql(query)), response });
    expect(response.statusCode).toBe(400);
    expect(response.bodyText()).toContain('outside');
  });
});
