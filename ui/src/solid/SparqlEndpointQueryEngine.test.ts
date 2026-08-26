// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSparqlEndpointQueryEngine } from './SparqlEndpointQueryEngine';

const endpoint = 'https://pod.example/alice/settings/-/sparql';

describe('SparqlEndpointQueryEngine', () => {
  it('posts SELECT through the authenticated context fetch and returns RDF terms', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('accept')).toBe('application/sparql-results+json');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/sparql-query');
      expect(init?.body).toBe('SELECT * WHERE { ?s ?p ?o }');
      return new Response(JSON.stringify({
        head: { vars: ['s', 'count'] },
        results: {
          bindings: [{
            s: { type: 'uri', value: 'https://pod.example/alice/resource' },
            count: {
              type: 'literal',
              value: '2',
              datatype: 'http://www.w3.org/2001/XMLSchema#integer',
            },
          }],
        },
      }), { headers: { 'content-type': 'application/sparql-results+json' } });
    });
    const engine = createSparqlEndpointQueryEngine();

    const stream = await engine.queryBindings('SELECT * WHERE { ?s ?p ?o }', {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: fetchImpl,
    });
    const rows = await stream.toArray() as Array<Map<string, unknown>>;

    expect(fetchImpl).toHaveBeenCalledWith(endpoint, expect.any(Object));
    expect(rows[0]?.get('s')).toEqual({
      termType: 'NamedNode',
      value: 'https://pod.example/alice/resource',
    });
    expect(rows[0]?.get('count')).toEqual({
      termType: 'Literal',
      value: '2',
      datatype: {
        termType: 'NamedNode',
        value: 'http://www.w3.org/2001/XMLSchema#integer',
      },
    });
  });

  it('decodes ASK and rejects endpoint failures without falling back', async () => {
    const engine = createSparqlEndpointQueryEngine();
    await expect(engine.queryBoolean('ASK { ?s ?p ?o }', {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: async () => new Response(JSON.stringify({ boolean: true }), {
        headers: { 'content-type': 'application/sparql-results+json' },
      }),
    })).resolves.toBe(true);

    await expect(engine.queryBoolean('ASK { ?s ?p ?o }', {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: async () => new Response('denied', { status: 403, statusText: 'Forbidden' }),
    })).rejects.toThrow('SPARQL endpoint query failed: 403 Forbidden');

    await expect(engine.queryBoolean('ASK { ?s ?p ?o }', {
      sources: [{ type: 'sparql', value: endpoint }],
    })).rejects.toThrow('SPARQL endpoint query requires the authenticated context fetch');
  });

  it('queries a .ttl URL as an authenticated Comunica RDF document source', async () => {
    const document = 'https://pod.example/alice/settings/providers/openai.ttl';
    const fetchImpl = vi.fn(async () => new Response(`
      <${document}#openai> <https://schema.org/name> "OpenAI" .
    `, {
      headers: { 'content-type': 'text/turtle' },
    }));
    const engine = createSparqlEndpointQueryEngine();

    const stream = await engine.queryBindings(`
      SELECT ?name WHERE {
        <${document}#openai> <https://schema.org/name> ?name .
      }
    `, {
      sources: [document],
      fetch: fetchImpl,
    });
    const rows = await stream.toArray() as Array<Map<string, { value?: string }>>;

    expect(rows[0]?.get('name')?.value).toBe('OpenAI');
    expect(fetchImpl).toHaveBeenCalledWith(document, expect.objectContaining({ method: undefined }));
  });
});
