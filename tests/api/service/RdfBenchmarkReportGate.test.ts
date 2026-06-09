import { describe, expect, it } from 'vitest';
import type {
  RdfBenchmarkReportCatalogSnapshot,
  RdfBenchmarkReportSummary,
} from '../../../src/api/service/RdfBenchmarkReportCatalog';
import { evaluateRdfBenchmarkReportGate } from '../../../src/api/service/RdfBenchmarkReportGate';

describe('RdfBenchmarkReportGate', () => {
  it('accepts a full large real-PG report with release-gate evidence', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport()));

    expect(result).toMatchObject({
      matched: true,
      checkedReportCount: 1,
      failedReasons: [],
      matchedReport: {
        path: '.test-data/rdf-pg-large/models-postgres-large.json',
      },
    });
    expect(result.candidates[0]).toMatchObject({ matched: true, failedReasons: [] });
  });

  it('rejects undersized reports that do not prove planner stats, cold/warm timing, and concurrency', () => {
    const report = fullLargeReport({
      scale: 'medium',
      driver: 'pglite',
      seedQuadCount: 45_000,
      targetQuadCount: 1_000_000,
      fullScale: false,
      concurrency: 1,
      concurrencyMatched: false,
      copyRows: 0,
      plannerStatsAnalyzedTables: [],
      coldStartDurationMs: undefined,
      warmP95DurationMs: undefined,
      storageTotalToFactsRatio: undefined,
    });

    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(report));

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toEqual(expect.arrayContaining([
      'no report satisfied the gate; newest report .test-data/rdf-pg-large/models-postgres-large.json failed',
      'scale expected large, got medium',
      'driver expected pg, got pglite',
      'seedQuadCount expected >= 1000000, got 45000',
      'fullScale expected true, got false',
      'concurrency expected >= 4, got 1',
      'concurrency gate failed: concurrencyMatched is not true',
      'copyRows expected > 0, got 0',
      'plannerStatsAnalyzedTables is empty',
      'coldStartDurationMs expected > 0, got missing',
      'warmP95DurationMs expected > 0, got missing',
      'storageTotalToFactsRatio expected > 0, got missing',
    ]));
    expect(result.candidates[0].matched).toBe(false);
  });
});

function snapshotWithReport(report: RdfBenchmarkReportSummary): RdfBenchmarkReportCatalogSnapshot {
  return {
    roots: ['.test-data/rdf-pg-large'],
    reportCount: 1,
    skippedFiles: 0,
    errors: [],
    reports: [report],
  };
}

function fullLargeReport(overrides: Partial<RdfBenchmarkReportSummary> = {}): RdfBenchmarkReportSummary {
  return {
    id: 'models-postgres-large',
    path: '.test-data/rdf-pg-large/models-postgres-large.json',
    generatedAt: '2026-06-09T08:00:00.000Z',
    engine: 'postgres-rdf',
    driver: 'pg',
    scale: 'large',
    caseProfile: 'extreme',
    rdfAccelerationProfile: 'baseline',
    seedQuadCount: 1_025_000,
    targetQuadCount: 1_000_000,
    fullScale: true,
    iterations: 3,
    warmupIterations: 1,
    concurrency: 4,
    planMatched: true,
    failedPlanCases: [],
    concurrencyMatched: true,
    failedConcurrencyCases: [],
    ingestDurationMs: 12_345,
    copyRows: 1_024_990,
    copyFallbacks: 0,
    refreshDurationMs: 2_345,
    plannerStatsDurationMs: 567,
    plannerStatsAnalyzedTables: ['rdf_quads', 'rdf3x_graph_stats'],
    coldStartDurationMs: 200,
    firstQueryDurationMs: 150,
    warmP50DurationMs: 25,
    warmP95DurationMs: 40,
    storageFactsBytes: 120_000_000,
    storageDerivedBytes: 80_000_000,
    storageTotalBytes: 200_000_000,
    storageTotalToFactsRatio: 1.67,
    pgAccelerationEnabled: true,
    pgActiveOperators: [],
    ...overrides,
  };
}
