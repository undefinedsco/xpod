import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { UnsupportedSparqlQueryError } from '../../../src/storage/rdf/RdfSparqlBoundary';
import { RdfQuerySparqlEngine } from '../../../src/storage/rdf/RdfQuerySparqlEngine';
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
    query: vi.fn(async (_query: RdfQuery) => result),
    applyDelta: vi.fn(async () => ({ deletedRows: 0, insertedRows: 0 })),
    refreshDerivedIndexes: vi.fn(),
    storageStats: vi.fn(),
  } as unknown as RdfEngineLike & {
    query: ReturnType<typeof vi.fn>;
    applyDelta: ReturnType<typeof vi.fn>;
  };
}

describe('RdfQuerySparqlEngine', () => {
  it('compiles SELECT and ASK to the RDF facts engine', async () => {
    const rdfEngine = fakeEngine(queryResult([ {
      s: namedNode('https://pod.example/alice/card#me'),
      label: literal('Alice'),
    } ]));
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
    expect(rdfEngine.query).toHaveBeenCalledWith(expect.objectContaining({
      select: [ 's', 'label' ],
    }));

    await expect(sparql.queryBoolean('ASK { ?s ?p ?o }', 'https://pod.example/alice/'))
      .resolves.toBe(true);
  });

  it('materializes CONSTRUCT results without native SPARQL', async () => {
    const rdfEngine = fakeEngine(queryResult([ {
      s: namedNode('https://pod.example/alice/card#me'),
      p: namedNode('https://schema.org/name'),
      o: literal('Alice'),
    } ]));
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

  it('lists and constructs authorized graphs from the RDF facts engine', async () => {
    const rdfEngine = fakeEngine(queryResult([ {
      g: namedNode('https://pod.example/alice/public.ttl'),
      s: namedNode('https://pod.example/alice/card#me'),
      p: namedNode('https://schema.org/name'),
      o: literal('Alice'),
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
