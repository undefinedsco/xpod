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

  it('rejects strict P3 release reports without calibrated serving and fusion thresholds', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      servingRegressionThresholdsConfigured: false,
      fusionBenchmarkThresholdsConfigured: false,
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toEqual(expect.arrayContaining([
      'serving regression thresholds are not configured',
      'fusion benchmark thresholds are not configured',
    ]));
  });

  it('rejects strict P3 release reports without auditable benchmark gate config sources', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      benchmarkGateConfigSourcesConfigured: false,
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireBenchmarkGateConfigSources: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('benchmark gate config sources are not configured');
  });

  it('rejects strict P3 release reports unless the fusion baseline source is a report artifact', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      benchmarkGateConfigSourcesConfigured: true,
      fusionBaselineReportSourceConfigured: false,
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireBenchmarkGateConfigSources: true,
      requireFusionBaselineReportSource: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('fusion baseline report source is not configured');
  });

  it('rejects strict P3 release reports when benchmark gate source shape differs from the report shape', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      benchmarkGateConfigSourceShapeMismatches: [
        'source[0].targetQuads expected 1000000, got 50000',
      ],
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireBenchmarkGateConfigSources: true,
      requireFusionBaselineReportSource: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('benchmark gate config source shape mismatch: source[0].targetQuads expected 1000000, got 50000');
  });

  it('rejects strict P3 release reports unless the fusion baseline source is the RDF3X baseline profile', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      fusionBaselineReportSourceBaselineProfileConfigured: false,
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireBenchmarkGateConfigSources: true,
      requireFusionBaselineReportSource: true,
      requireFusionBaselineSourceBaselineProfile: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('fusion baseline source baseline profile is not configured');
  });

  it('rejects strict P3 release reports without fusion hard-filter and batched-join case evidence', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      fusionHardFiltersBeforeRankCaseCount: 0,
      fusionBatchedBroadCandidateJoinCaseCount: 0,
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireBenchmarkGateConfigSources: true,
      requireFusionBaselineReportSource: true,
      requireFusionBaselineSourceBaselineProfile: true,
      requireFusionHardFilterEvidence: true,
      requireFusionBatchedBroadCandidateJoinEvidence: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toEqual(expect.arrayContaining([
      'fusion hard-filter-before-rank evidence expected > 0, got 0',
      'fusion batched broad candidate join evidence expected > 0, got 0',
    ]));
  });

  it('rejects P4 native FTS benchmark reports that do not use the required text backend', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      textSearchBackend: 'posting',
    })), {
      requiredTextSearchBackend: 'pg-native-fts',
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('textSearchBackend expected pg-native-fts, got posting');
  });

  it('rejects P4 native FTS benchmark reports without native physical-plan evidence', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      nativeTextFtsCaseCount: 0,
    })), {
      requiredTextSearchBackend: 'pg-native-fts',
      requireNativeTextFtsEvidence: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('native text FTS evidence expected > 0, got 0');
  });

  it('rejects strict P3 release reports with too few timing iterations', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'all',
      iterations: 1,
      warmupIterations: 0,
    })), {
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toEqual(expect.arrayContaining([
      'iterations expected >= 3, got 1',
      'warmupIterations expected >= 1, got 0',
    ]));
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

  it('rejects strict P3 evidence unless the report uses the combined all profile', () => {
    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(fullLargeReport({
      caseProfile: 'fusion',
    })), {
      requiredCaseProfile: 'all',
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toContain('caseProfile expected all, got fusion');
  });

  it('rejects reports when required serving or fusion gates failed', () => {
    const report = fullLargeReport({
      caseProfile: 'fusion',
      servingRegressionMatched: false,
      failedServingRegressionCases: ['modeled thread message page query'],
      fusionBenchmarkMatched: false,
      failedFusionBenchmarkCases: ['broad agent context text vector fusion query'],
      fusionBaselineComparisonMatched: false,
      failedFusionBaselineComparisonCases: ['broad agent context text vector fusion query'],
    });

    const result = evaluateRdfBenchmarkReportGate(snapshotWithReport(report), {
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
    });

    expect(result.matched).toBe(false);
    expect(result.failedReasons).toEqual(expect.arrayContaining([
      'serving regression gate failed: modeled thread message page query',
      'fusion benchmark gate failed: broad agent context text vector fusion query',
      'fusion baseline comparison gate failed: broad agent context text vector fusion query',
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
    textSearchBackend: 'pg-native-fts',
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
    servingRegressionMatched: true,
    servingRegressionThresholdsConfigured: true,
    failedServingRegressionCases: [],
    fusionBenchmarkMatched: true,
    fusionBenchmarkThresholdsConfigured: true,
    failedFusionBenchmarkCases: [],
    fusionBaselineComparisonMatched: true,
    failedFusionBaselineComparisonCases: [],
    benchmarkGateConfigSourcesConfigured: true,
    fusionBaselineReportSourceConfigured: true,
    benchmarkGateConfigSourceShapeMismatches: [],
    fusionBaselineReportSourceBaselineProfileConfigured: true,
    fusionHardFiltersBeforeRankCaseCount: 2,
    fusionBatchedBroadCandidateJoinCaseCount: 1,
    nativeTextFtsCaseCount: 2,
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
