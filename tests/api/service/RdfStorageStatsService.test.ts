import { describe, expect, it, vi } from 'vitest';
import { RdfStorageStatsService } from '../../../src/api/service/RdfStorageStatsService';

describe('RdfStorageStatsService', () => {
  it('uses the injected API RDF engine instead of opening a separate stats engine', async () => {
    const stats = {
      factsBytes: 10,
      derivedBytes: 4,
      totalBytes: 14,
      totalToFactsRatio: 1.4,
      derivedToFactsRatio: 0.4,
    };
    const rdfEngine = {
      storageStats: vi.fn().mockResolvedValue(stats),
    };

    await expect(new RdfStorageStatsService({
      edition: 'cloud',
      rdfEngine,
    }).snapshot({ cacheScope: { query: 'alice' } })).resolves.toMatchObject({
      available: true,
      engine: 'postgres-rdf',
      stats,
    });

    expect(rdfEngine.storageStats).toHaveBeenCalledWith({ cacheScope: { query: 'alice' } });
  });

  it('reports local mode as unavailable instead of opening the CSS sqlite index from the API process', async () => {
    await expect(new RdfStorageStatsService({
      edition: 'local',
      sparqlEndpoint: 'sqlite:/tmp/xpod-rdf.sqlite',
    }).snapshot()).resolves.toMatchObject({
      available: false,
      engine: 'unsupported',
      reason: 'not-cloud',
    });
  });

  it('reports unsupported cloud endpoints without attempting a PostgreSQL connection', async () => {
    await expect(new RdfStorageStatsService({
      edition: 'cloud',
      sparqlEndpoint: 'sqlite:/tmp/xpod-rdf.sqlite',
    }).snapshot()).resolves.toMatchObject({
      available: false,
      engine: 'unsupported',
      reason: 'unsupported-sparql-endpoint',
    });
  });
});
