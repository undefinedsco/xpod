import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { SparqlStrategy } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/execution/sparql-strategy.js');

describe('drizzle-solid SparqlStrategy endpoint routing', () => {
  it.each([
    [ 'relative endpoint', '/settings/-/sparql', 'https://pod.example/alice/settings/-/sparql' ],
    [ 'absolute endpoint', 'https://pod.example/alice/custom/-/sparql', 'https://pod.example/alice/custom/-/sparql' ],
  ])('queries the configured table SPARQL endpoint for a %s', async (_name, endpoint, expectedSource) => {
    const executeQueryWithSource = vi.fn(async () => []);
    const strategy = new SparqlStrategy({
      sparqlExecutor: { executeQueryWithSource },
      sparqlConverter: {
        convertSelectPlan: vi.fn(() => ({ queryType: 'SELECT' })),
      },
      podUrl: 'https://pod.example/alice/',
      uriResolver: { getResourceMode: vi.fn(() => 'document') },
      createQueryEngine: undefined,
    });

    await strategy.executeSelect({
      baseTable: {
        config: {},
        getContainerPath: () => '/settings/providers/',
        getSparqlEndpoint: () => endpoint,
      },
    }, 'https://pod.example/alice/settings/providers/', 'https://pod.example/alice/settings/providers/openai.ttl');

    expect(executeQueryWithSource).toHaveBeenCalledWith(
      { queryType: 'SELECT' },
      expectedSource,
      'sparql',
    );
  });
});
