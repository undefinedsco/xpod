import { describe, expect, it, vi } from 'vitest';
import type { RdfEngineLike, RdfNativeSparqlQueryOptions } from '../../src/storage/rdf/types';
import {
  assertSemanticDefaultDataset,
  semanticCaseDefaultDataset,
  type SemanticFixtureCase,
} from '../../src/acceptance/RdfSemanticConformance';
import { queryNativeSemanticCase } from '../../src/acceptance/QleverSemanticConformance';
import { runPublicRdfQuerySemanticCase } from '../../src/acceptance/PublicCloudSemanticConformance';

/** Boundary unit coverage for the reviewed top-level `defaultDataset`.
 *
 * The load-bearing assertion is that the REAL native forwarding seam — the same
 * function `nativeSemanticCaseExecutor` calls — passes the selected mode into
 * `engine.sparqlQuery`. Resolver-only assertions would not prove that.
 *
 * These are mock-boundary unit tests: they prove the options handed to the
 * existing engine contract, not that a real QLever process executed a query.
 */
const baseCase = (extra: Partial<SemanticFixtureCase> = {}): SemanticFixtureCase => ({
  id: 'case-1',
  documents: [],
  updates: [],
  query: 'SELECT * WHERE { ?s ?p ?o }',
  acceptMediaType: 'application/sparql-results+json',
  accessScope: {
    principal: 'p',
    mode: 'read',
    allowedGraphs: ['https://pod.example/allowed'],
    allowedSources: ['https://pod.example/src'],
    deniedGraphs: ['https://pod.example/denied'],
    deniedSources: [],
  },
  expectedCanonical: {},
  ...extra,
});

/** Typed engine stub: only the native SPARQL surface this seam consumes. */
function nativeEngine(capture: RdfNativeSparqlQueryOptions[]): RdfEngineLike {
  return {
    sparqlQuery: vi.fn((query: string, options: RdfNativeSparqlQueryOptions) => {
      capture.push(options);
      return {
        status: 'ok' as const,
        mediaType: 'application/sparql-results+json',
        body: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
        queryStatus: 0,
      };
    }),
  } as unknown as RdfEngineLike;
}

describe('native executor forwards the selected dataset to the engine', () => {
  it('passes a DECLARED physical mode into engine.sparqlQuery', async () => {
    const seen: RdfNativeSparqlQueryOptions[] = [];
    const testCase = baseCase({ defaultDataset: 'physical' });

    await queryNativeSemanticCase(nativeEngine(seen), testCase, 1_000);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.defaultDataset).toBe('physical');
    // the rest of the existing engine contract is preserved verbatim
    expect(seen[0]!.basePath).toBe('urn:xpod:semantic:');
    expect(seen[0]!.timeoutMs).toBe(1_000);
    expect(seen[0]!.operation).toBe('queryBindings');
    expect(seen[0]!.acceptMediaType).toBe('application/sparql-results+json');
    expect(seen[0]!.accessScope).toMatchObject({
      mode: 'read',
      resolved: true,
      allowedGraphUrls: ['https://pod.example/allowed'],
      deniedGraphUrls: ['https://pod.example/denied'],
    });
  });

  it('passes exactSource and keeps the query text unrewritten', async () => {
    const seen: RdfNativeSparqlQueryOptions[] = [];
    const engine = nativeEngine(seen);
    const testCase = baseCase({ defaultDataset: 'exactSource' });

    await queryNativeSemanticCase(engine, testCase, undefined);

    expect(seen[0]!.defaultDataset).toBe('exactSource');
    expect(engine.sparqlQuery).toHaveBeenCalledWith(testCase.query, expect.anything());
  });

  it('falls back to scopedUnion when the declaration is ABSENT', async () => {
    const seen: RdfNativeSparqlQueryOptions[] = [];

    await queryNativeSemanticCase(nativeEngine(seen), baseCase(), undefined);

    expect(seen[0]!.defaultDataset).toBe('scopedUnion');
  });

  it('rejects an invalid declaration BEFORE the engine is called', async () => {
    const seen: RdfNativeSparqlQueryOptions[] = [];
    const engine = nativeEngine(seen);

    // The seam validates before returning a promise, so it throws synchronously.
    expect(() =>
      queryNativeSemanticCase(engine, baseCase({ defaultDataset: 'graph' as never }), 1_000),
    ).toThrow(/unsupported defaultDataset/u);

    expect(engine.sparqlQuery).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
});

describe('resolver and validator contract', () => {
  it('follows the declaration, never the case id', () => {
    expect(semanticCaseDefaultDataset(baseCase({ id: 'same', defaultDataset: 'physical' })))
      .toBe('physical');
    expect(semanticCaseDefaultDataset(baseCase({ id: 'same', defaultDataset: 'scopedUnion' })))
      .toBe('scopedUnion');
  });

  it('fails closed on unknown runtime values instead of falling back', () => {
    for (const bad of ['Physical', 'DEFAULT', 'physical ', '', 7, null, true]) {
      expect(() => assertSemanticDefaultDataset(bad, 'case-1: defaultDataset'))
        .toThrow(/unsupported defaultDataset/u);
    }
  });
});

describe('public RDF query authority cannot represent a dataset declaration', () => {
  it('rejects a declared physical dataset with explicit evidence', async () => {
    // `RdfQuerySparqlEngine` accepts `timeoutMs` only, so the public path fails
    // closed before any query. Minimal stub: the guard throws first.
    const engine = {
      open: async () => {},
      close: async () => {},
      refreshDerivedIndexes: async () => {},
    } as unknown as RdfEngineLike;

    await expect(
      runPublicRdfQuerySemanticCase(engine, baseCase({ defaultDataset: 'physical' }), 1_000, 'pg-public'),
    ).rejects.toThrow(/public RDF query authority cannot represent defaultDataset='physical'/u);
  });
});
