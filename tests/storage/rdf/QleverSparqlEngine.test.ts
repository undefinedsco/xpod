import { describe, expect, it, vi } from 'vitest';
import { DisabledSparqlFeatureError } from '../../../src/storage/rdf/RdfSparqlBoundary';
import { QleverSparqlEngine } from '../../../src/storage/rdf/QleverSparqlEngine';
import type {
  RdfEngineLike,
  RdfNativeSparqlQueryOptions,
  RdfNativeSparqlResult,
} from '../../../src/storage/rdf/types';

function engineReturning(result: RdfNativeSparqlResult): {
  engine: QleverSparqlEngine;
  sparqlQuery: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sparqlQuery = vi.fn(async (_query: string, _options: RdfNativeSparqlQueryOptions) => result);
  const close = vi.fn();
  const rdfEngine = {
    sparqlQuery,
    close,
  } as unknown as RdfEngineLike;
  return { engine: new QleverSparqlEngine(rdfEngine), sparqlQuery, close };
}

describe('QleverSparqlEngine', () => {
  it('requires the native QLever seam', () => {
    expect(() => new QleverSparqlEngine({ close: vi.fn() } as unknown as RdfEngineLike))
      .toThrow('requires an RdfEngine with native SPARQL support');
  });

  it('decodes SELECT bindings and forwards scope, timeout, and abort', async () => {
    const { engine, sparqlQuery } = engineReturning({
      status: 'ok',
      mediaType: 'application/sparql-results+json',
      body: JSON.stringify({
        head: { vars: [ 's', 'label' ] },
        results: {
          bindings: [ {
            s: { type: 'uri', value: 'https://pod.example/a' },
            label: { type: 'literal', value: '你好', 'xml:lang': 'zh' },
          } ],
        },
      }),
    });
    const controller = new AbortController();
    const stream = await engine.queryBindings('SELECT ?s ?label WHERE { ?s ?p ?label }', 'https://pod.example/', {
      basePath: 'https://pod.example/',
      mode: 'read',
      allowedGraphUrls: [ 'https://pod.example/a.ttl' ],
    }, { timeoutMs: 500, signal: controller.signal });
    const rows = [];
    for await (const row of stream) {
      rows.push(row);
    }

    expect((await stream.metadata()).variables.map((variable) => variable.value)).toEqual([ 's', 'label' ]);
    expect(rows[0].get('s')).toMatchObject({
      termType: 'NamedNode',
      value: 'https://pod.example/a',
    });
    expect(rows[0].get('label')).toMatchObject({
      termType: 'Literal',
      value: '你好',
      language: 'zh',
    });
    expect(sparqlQuery).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      operation: 'queryBindings',
      timeoutMs: 500,
      signal: controller.signal,
      accessScope: expect.objectContaining({
        allowedGraphUrls: [ 'https://pod.example/a.ttl' ],
      }),
    }));
  });

  it('decodes ASK and graph results', async () => {
    const ask = engineReturning({
      status: 'ok',
      mediaType: 'application/sparql-results+json',
      body: '{"boolean":true}',
    });
    await expect(ask.engine.queryBoolean('ASK {}', 'https://pod.example/')).resolves.toBe(true);

    const graph = engineReturning({
      status: 'ok',
      mediaType: 'application/n-quads',
      body: '<https://pod.example/s> <https://pod.example/p> "value" <https://pod.example/g> .\n',
    });
    const stream = await graph.engine.queryQuads('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'https://pod.example/');
    const rows = [];
    for await (const quad of stream) {
      rows.push(quad);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0].graph.value).toBe('https://pod.example/g');
  });

  it('uses QLever for graph listing and graph construction', async () => {
    const { engine, sparqlQuery } = engineReturning({
      status: 'ok',
      mediaType: 'application/sparql-results+json',
      body: JSON.stringify({
        head: { vars: [ 'g' ] },
        results: { bindings: [ { g: { type: 'uri', value: 'https://pod.example/a.ttl' } } ] },
      }),
    });
    await expect(engine.listGraphs('https://pod.example/')).resolves.toEqual(new Set([ 'https://pod.example/a.ttl' ]));
    expect(sparqlQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT DISTINCT ?g'), expect.any(Object));
  });

  it('requires the authority path for every direct update', async () => {
    const { engine, sparqlQuery } = engineReturning({
      status: 'ok',
      mediaType: 'application/json',
      body: '{}',
    });
    await expect(engine.queryVoid('INSERT DATA {}', 'https://pod.example/')).rejects.toMatchObject({
      code: 'rdf.sparql.update_authority_required',
    });
    expect(sparqlQuery).not.toHaveBeenCalled();
  });

  it('fails closed on unsupported, error, timeout, and invalid result shapes', async () => {
    await expect(engineReturning({
      status: 'unsupported',
      mediaType: 'application/json',
      body: '',
      error: 'shape unavailable',
    }).engine.queryBoolean('ASK {}', 'https://pod.example/')).rejects.toMatchObject({
      name: 'UnsupportedSparqlQueryError',
    });

    await expect(engineReturning({
      status: 'error',
      mediaType: 'application/json',
      body: '',
      error: 'cancelled',
      queryStatus: 3,
    }).engine.queryBoolean('ASK {}', 'https://pod.example/', undefined, { timeoutMs: 10 }))
      .rejects.toMatchObject({ name: 'NativeSparqlTimeoutError' });

    await expect(engineReturning({
      status: 'ok',
      mediaType: 'application/sparql-results+json',
      body: '{}',
    }).engine.queryBoolean('ASK {}', 'https://pod.example/'))
      .rejects.toMatchObject({ name: 'NativeSparqlExecutionError' });
  });

  it('blocks external SERVICE before invoking QLever and closes the backing engine', async () => {
    const { engine, sparqlQuery, close } = engineReturning({
      status: 'ok',
      mediaType: 'application/sparql-results+json',
      body: '{"boolean":true}',
    });
    await expect(engine.queryBoolean(`ASK { SERVICE <https://external.example/sparql> { ?s ?p ?o } }`, 'https://pod.example/'))
      .rejects.toBeInstanceOf(DisabledSparqlFeatureError);
    expect(sparqlQuery).not.toHaveBeenCalled();
    await engine.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
