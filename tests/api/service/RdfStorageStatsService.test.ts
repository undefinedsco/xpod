import { describe, expect, it } from 'vitest';
import { RdfStorageStatsService } from '../../../src/api/service/RdfStorageStatsService';

describe('RdfStorageStatsService', () => {
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
