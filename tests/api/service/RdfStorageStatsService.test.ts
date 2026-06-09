import { describe, expect, it, vi } from 'vitest';
import { RdfStorageStatsService } from '../../../src/api/service/RdfStorageStatsService';

function emptyBenchmarkReportCatalog() {
  return {
    snapshot: vi.fn().mockResolvedValue({
      roots: [],
      reportCount: 0,
      skippedFiles: 0,
      errors: [],
      reports: [],
    }),
  };
}

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
      benchmarkReportCatalog: emptyBenchmarkReportCatalog(),
    }).snapshot({ cacheScope: { query: 'alice' } })).resolves.toMatchObject({
      available: true,
      engine: 'postgres-rdf',
      stats,
    });

    expect(rdfEngine.storageStats).toHaveBeenCalledWith({ cacheScope: { query: 'alice' } });
  });

  it('includes benchmark report summaries in cloud stats snapshots', async () => {
    const rdfEngine = {
      storageStats: vi.fn().mockResolvedValue({
        factsBytes: 10,
        derivedBytes: 4,
        totalBytes: 14,
        totalToFactsRatio: 1.4,
        derivedToFactsRatio: 0.4,
      }),
    };
    const benchmarkReports = {
      roots: ['.test-data/rdf-engine'],
      reportCount: 1,
      skippedFiles: 0,
      errors: [],
      reports: [{
        id: 'models-postgres-sample',
        path: '.test-data/rdf-engine/models-postgres-sample.json',
        generatedAt: '2026-06-09T00:00:00.000Z',
        engine: 'postgres-rdf',
        failedPlanCases: [],
        failedConcurrencyCases: [],
        pgActiveOperators: [],
      }],
    };
    const benchmarkReportCatalog = {
      snapshot: vi.fn().mockResolvedValue(benchmarkReports),
    };

    await expect(new RdfStorageStatsService({
      edition: 'cloud',
      rdfEngine,
      benchmarkReportCatalog,
    }).snapshot()).resolves.toMatchObject({
      available: true,
      benchmarkReports,
    });

    expect(benchmarkReportCatalog.snapshot).toHaveBeenCalledTimes(1);
  });

  it('reports local mode as unavailable instead of opening the CSS sqlite index from the API process', async () => {
    const benchmarkReports = {
      roots: ['.test-data/rdf-engine'],
      reportCount: 0,
      skippedFiles: 0,
      errors: [],
      reports: [],
    };
    await expect(new RdfStorageStatsService({
      edition: 'local',
      sparqlEndpoint: 'sqlite:/tmp/xpod-rdf.sqlite',
      benchmarkReportCatalog: { snapshot: vi.fn().mockResolvedValue(benchmarkReports) },
    }).snapshot()).resolves.toMatchObject({
      available: false,
      engine: 'unsupported',
      reason: 'not-cloud',
      benchmarkReports,
    });
  });

  it('reports unsupported cloud endpoints without attempting a PostgreSQL connection', async () => {
    await expect(new RdfStorageStatsService({
      edition: 'cloud',
      sparqlEndpoint: 'sqlite:/tmp/xpod-rdf.sqlite',
      benchmarkReportCatalog: emptyBenchmarkReportCatalog(),
    }).snapshot()).resolves.toMatchObject({
      available: false,
      engine: 'unsupported',
      reason: 'unsupported-sparql-endpoint',
    });
  });
});
