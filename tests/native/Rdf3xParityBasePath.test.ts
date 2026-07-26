import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { RdfSparqlAdapter } from '../../src/storage/rdf/RdfSparqlAdapter';
import { RDF3X_PARITY_BASE_PATH } from '../../scripts/native-rdf3x-benchmark';

describe('RDF3X parity query scope', () => {
  it('covers the generated example.test named graphs', async () => {
    const compiled = new RdfSparqlAdapter().compile(
      'SELECT ?o WHERE { GRAPH ?graph { <https://example.test/entity/42> <https://schema.example.test/name> ?o } }',
      RDF3X_PARITY_BASE_PATH,
    );
    const source = await readFile(
      new URL('../../scripts/native-rdf3x-benchmark.ts', import.meta.url),
      'utf8',
    );

    expect(RDF3X_PARITY_BASE_PATH).toBe('https://example.test/');
    expect(compiled.query.filters).toContainEqual({
      variable: 'graph',
      operator: '$startsWith',
      value: 'https://example.test/',
    });
    expect(source).toContain(
      'sparql.queryBindings(query, RDF3X_PARITY_BASE_PATH, undefined',
    );
  });
});
