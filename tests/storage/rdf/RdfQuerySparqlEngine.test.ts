import { DataFactory, Parser } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { RdfQuadIndex } from '../../../src/storage/rdf/RdfQuadIndex';
import {
  NativeSparqlTimeoutError,
  UnsupportedSparqlQueryError,
} from '../../../src/storage/rdf/RdfSparqlBoundary';
import { RdfQuerySparqlEngine } from '../../../src/storage/rdf/RdfQuerySparqlEngine';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import type { RdfEngineLike, RdfQuery, RdfQueryResult } from '../../../src/storage/rdf/types';

const { namedNode, literal } = DataFactory;

function queryResult(bindings: RdfQueryResult['bindings']): RdfQueryResult {
  return {
    bindings,
    metrics: {
      engine: 'solid-rdf',
      plan: [ 'fake' ],
      scannedRows: bindings.length,
      joinedRows: bindings.length,
      returnedRows: bindings.length,
      durationMs: 0,
      indexChoices: [],
      filtersApplied: 0,
      filtersPushedDown: 0,
    },
  };
}

function fakeEngine(result: RdfQueryResult = queryResult([])): RdfEngineLike & {
  query: ReturnType<typeof vi.fn>;
  applyDelta: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(),
    close: vi.fn(),
    put: vi.fn(),
    replaceSource: vi.fn(),
    deleteSource: vi.fn(),
    delete: vi.fn(),
    scan: vi.fn(),
    query: vi.fn(async (query: RdfQuery) => query.aggregates?.[0]?.type === 'count'
      ? queryResult([{ count: literal(String(result.bindings.length)) }])
      : result),
    applyDelta: vi.fn(async () => ({ deletedRows: 0, insertedRows: 0 })),
    refreshDerivedIndexes: vi.fn(),
    storageStats: vi.fn(),
  } as unknown as RdfEngineLike & {
    query: ReturnType<typeof vi.fn>;
    applyDelta: ReturnType<typeof vi.fn>;
  };
}

describe('RdfQuerySparqlEngine', () => {
  it('executes SELECT and ASK with full SPARQL semantics over the RDF facts engine', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    await rdfEngine.replaceSource(new Parser({ baseIRI: 'https://pod.example/alice/card' }).parse(`
      <#me> <https://schema.org/name> "Alice" .
    `), {
      source: 'https://pod.example/alice/card',
      workspace: 'https://pod.example/alice/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    const bindings = await sparql.queryBindings(
      'SELECT ?s ?label WHERE { ?s <https://schema.org/name> ?label }',
      'https://pod.example/alice/',
    );
    const rows = [];
    for await (const row of bindings) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0].get('s')?.value).toBe('https://pod.example/alice/card#me');
    expect((await bindings.metadata()).variables.map((variable) => variable.value)).toEqual([ 's', 'label' ]);
    await expect(sparql.queryBoolean('ASK { ?s ?p ?o }', 'https://pod.example/alice/'))
      .resolves.toBe(true);

    await sparql.close();
  });

  it('keeps physical default graph facts isolated by Pod source', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    await rdfEngine.replaceSource(new Parser().parse('<urn:s> <urn:p> "Alice" .'), {
      source: 'https://pod.example/alice/default.ttl',
      workspace: 'https://pod.example/alice/',
    });
    await rdfEngine.replaceSource(new Parser().parse('<urn:s> <urn:p> "Bob" .'), {
      source: 'https://pod.example/bob/default.ttl',
      workspace: 'https://pod.example/bob/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    await expect(bindingValues(await sparql.queryBindings(
      'SELECT ?value WHERE { <urn:s> <urn:p> ?value }',
      'https://pod.example/alice/',
    ), 'value')).resolves.toEqual(['Alice']);

    await sparql.close();
  });

  it('materializes CONSTRUCT results with full SPARQL semantics', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    await rdfEngine.replaceSource(new Parser({ baseIRI: 'https://pod.example/alice/card' }).parse(`
      <#me> <https://schema.org/name> "Alice" .
    `), {
      source: 'https://pod.example/alice/card',
      workspace: 'https://pod.example/alice/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    const quads = [];
    const stream = await sparql.queryQuads(
      'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      'https://pod.example/alice/',
    );
    for await (const item of stream) {
      quads.push(item);
    }

    expect(quads).toHaveLength(1);
    expect(quads[0].subject.value).toBe('https://pod.example/alice/card#me');
    expect(quads[0].object.value).toBe('Alice');
    expect(quads[0].graph.termType).toBe('DefaultGraph');

    await sparql.close();
  });

  it('materializes DESCRIBE results as default graph quads', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    await rdfEngine.replaceSource(new Parser().parse(`
      <https://pod.example/alice/card#me> <https://schema.org/name> "Alice" .
    `), {
      source: 'https://pod.example/alice/card',
      workspace: 'https://pod.example/alice/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    const quads = [];
    const stream = await sparql.queryQuads(
      'DESCRIBE <https://pod.example/alice/card#me>',
      'https://pod.example/alice/',
    );
    for await (const item of stream) {
      quads.push(item);
    }

    expect(quads).toHaveLength(1);
    expect(quads[0].subject.value).toBe('https://pod.example/alice/card#me');
    expect(quads[0].graph.termType).toBe('DefaultGraph');
    await sparql.close();
  });

  it('orders numeric NaN after infinities before applying LIMIT and OFFSET', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    await rdfEngine.replaceSource(new Parser().parse(`
      <urn:value> <urn:number> "NaN"^^<http://www.w3.org/2001/XMLSchema#double> .
      <urn:value> <urn:number> "INF"^^<http://www.w3.org/2001/XMLSchema#double> .
      <urn:value> <urn:number> "-INF"^^<http://www.w3.org/2001/XMLSchema#double> .
    `), {
      source: 'https://pod.example/alice/numbers.ttl',
      workspace: 'https://pod.example/alice/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    const firstPage = await bindingValues(await sparql.queryBindings(
      'SELECT ?value WHERE { <urn:value> <urn:number> ?value } ORDER BY ?value LIMIT 2',
      'https://pod.example/alice/',
    ), 'value');
    const secondPage = await bindingValues(await sparql.queryBindings(
      'SELECT ?value WHERE { <urn:value> <urn:number> ?value } ORDER BY ?value LIMIT 2 OFFSET 1',
      'https://pod.example/alice/',
    ), 'value');
    const extrema = await sparql.queryBindings(
      'SELECT (MIN(?value) AS ?min) (MAX(?value) AS ?max) WHERE { <urn:value> <urn:number> ?value }',
      'https://pod.example/alice/',
    );
    const extremaRows = [];
    for await (const binding of extrema) {
      extremaRows.push({ min: binding.get('min')?.value, max: binding.get('max')?.value });
    }

    expect(firstPage).toEqual([ '-INF', 'INF' ]);
    expect(secondPage).toEqual([ 'INF', 'NaN' ]);
    expect(extremaRows).toEqual([{ min: '-INF', max: 'NaN' }]);
    await sparql.close();
  });

  it('rejects direct UPDATE execution so writes stay on the Pod authority path', async () => {
    const rdfEngine = fakeEngine();
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    await expect(sparql.queryVoid(
      'INSERT DATA { <https://pod.example/alice/card#me> <https://schema.org/name> "Alice" . }',
      'https://pod.example/alice/',
    )).rejects.toBeInstanceOf(UnsupportedSparqlQueryError);

    expect(rdfEngine.applyDelta).not.toHaveBeenCalled();
  });

  it('rejects inline document loading instead of invoking a hidden executor', async () => {
    const sparql = new RdfQuerySparqlEngine(fakeEngine());

    await expect(sparql.queryVoid(
      'INSERT DATA { <urn:s> <urn:p> <urn:o> . }',
      'https://pod.example/alice/',
      undefined,
      {
        loadDocument: {
          sourceUri: 'https://pod.example/alice/input.ttl',
          body: '<urn:s> <urn:p> <urn:o> .',
        },
      },
    )).rejects.toMatchObject({
      capability: 'sparql.update.authority',
    });
  });

  it('blocks external SERVICE before invoking the RDF facts engine', async () => {
    const rdfEngine = fakeEngine();
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    await expect(sparql.queryBindings(
      'SELECT * WHERE { SERVICE <https://external.example/sparql> { ?s ?p ?o } }',
      'https://pod.example/alice/',
    )).rejects.toMatchObject({ name: 'DisabledSparqlFeatureError' });

    expect(rdfEngine.query).not.toHaveBeenCalled();
  });

  it('blocks QLever extension SERVICE in public Cloud before invoking the RDF facts engine', async () => {
    const rdfEngine = fakeEngine();
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    await expect(sparql.queryBindings(
      'SELECT * WHERE { SERVICE <https://qlever.cs.uni-freiburg.de/textSearch/> { ?s ?p ?o } }',
      'https://pod.example/alice/',
    )).rejects.toMatchObject({ name: 'DisabledSparqlFeatureError' });

    expect(rdfEngine.query).not.toHaveBeenCalled();
  });

  it('fails a pending facts query at the public Cloud timeout boundary', async () => {
    const rdfEngine = fakeEngine();
    rdfEngine.query.mockImplementation(() => new Promise(() => {}));
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    await expect(sparql.queryBoolean(
      'ASK { ?s ?p ?o }',
      'https://pod.example/alice/',
      undefined,
      { timeoutMs: 10 },
    )).rejects.toBeInstanceOf(NativeSparqlTimeoutError);
  });

  it('propagates a caller-provided abort reason through the public Cloud query boundary', async () => {
    const rdfEngine = fakeEngine();
    const sparql = new RdfQuerySparqlEngine(rdfEngine);
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);

    const pending = sparql.queryBindings(
      'SELECT ?s WHERE { ?s ?p ?o }',
      'https://pod.example/alice/',
      undefined,
      { signal: controller.signal },
    ).then((stream) => bindingValues(stream, 's'));
    await expect(pending).rejects.toBe(reason);
    expect(rdfEngine.query).not.toHaveBeenCalled();
  });

  it('destroys a public Cloud result stream when for-await consumption stops early', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    await rdfEngine.replaceSource(new Parser().parse(`
      <urn:a> <urn:p> "A" .
      <urn:b> <urn:p> "B" .
    `), {
      source: 'https://pod.example/alice/values.ttl',
      workspace: 'https://pod.example/alice/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);
    const stream = await sparql.queryBindings(
      'SELECT ?s WHERE { ?s <urn:p> ?value } ORDER BY ?s',
      'https://pod.example/alice/',
    );
    const destroy = vi.spyOn(stream, 'destroy');

    for await (const _binding of stream) {
      break;
    }

    expect(destroy).toHaveBeenCalledTimes(1);
    await sparql.close();
  });

  it('lists and constructs authorized graphs from the RDF facts engine', async () => {
    const rdfEngine = fakeEngine(queryResult([ {
      graph: namedNode('https://pod.example/alice/public.ttl'),
      subject: namedNode('https://pod.example/alice/card#me'),
      predicate: namedNode('https://schema.org/name'),
      object: literal('Alice'),
    } ]));
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    await expect(sparql.listGraphs('https://pod.example/alice/'))
      .resolves.toEqual(new Set([ 'https://pod.example/alice/public.ttl' ]));

    const stream = await sparql.constructGraph(
      'https://pod.example/alice/public.ttl',
      'https://pod.example/alice/',
    );
    const quads = [];
    for await (const item of stream) {
      quads.push(item);
    }
    expect(quads).toHaveLength(1);
    expect(quads[0].subject.value).toBe('https://pod.example/alice/card#me');
    expect(quads[0].predicate.value).toBe('https://schema.org/name');
    expect(quads[0].object.value).toBe('Alice');
    expect(quads[0].graph.value).toBe('https://pod.example/alice/public.ttl');
  });
});

async function bindingValues(
  stream: Awaited<ReturnType<RdfQuerySparqlEngine['queryBindings']>>,
  variable: string,
): Promise<string[]> {
  const values: string[] = [];
  for await (const binding of stream) {
    const value = binding.get(variable);
    if (value) {
      values.push(value.value);
    }
  }
  return values;
}
