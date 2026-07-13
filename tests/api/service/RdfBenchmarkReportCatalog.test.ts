import * as path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { RdfBenchmarkReportCatalog } from '../../../src/api/service/RdfBenchmarkReportCatalog';

const testRoot = path.join(process.cwd(), '.test-data', 'rdf-benchmark-report-catalog');

describe('RdfBenchmarkReportCatalog', () => {
  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('summarizes recent RDF benchmark report artifacts for the dashboard', async () => {
    const reportDir = path.join(testRoot, 'rdf-engine', 'latest');
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, 'models-postgres-2026-06-09T06-45-40-819Z-sample.json'),
      JSON.stringify({
        seed: {
          driver: 'pg',
          scale: 'medium',
          targetQuadCount: 36_000,
          seedQuadCount: 45_656,
          fullScale: true,
          iterations: 1,
          warmupIterations: 0,
          concurrency: 4,
          caseProfile: 'extreme',
          rdfAccelerationProfile: 'pg-hot-operators',
          textSearchBackend: 'pg-native-fts',
          benchmarkGateConfigSources: [
            {
              kind: 'report-config',
              path: '/tmp/models-postgres-baseline.json',
              calibratedLimits: true,
              seed: {
                driver: 'pg',
                scale: 'medium',
                targetQuads: 36_000,
                caseProfile: 'extreme',
                rdfAccelerationProfile: 'baseline',
              },
            },
          ],
          ingestDurationMs: 3734,
          bulkLoad: {
            copyFromRows: {
              rows: 65_166,
              fallbacks: 0,
            },
          },
        },
        report: {
          engine: 'postgres-rdf',
          scale: 'medium',
          caseProfile: 'extreme',
          iterations: 1,
          warmupIterations: 0,
          concurrency: 4,
          generatedAt: '2026-06-09T06:45:40.819Z',
          planMatched: true,
          failedPlanCases: [],
          concurrencyGate: {
            matched: true,
            failedCases: [],
          },
          servingRegressionGate: {
            matched: true,
            thresholds: {
              maxScannedRows: 1000,
              maxP95DurationMs: 100,
            },
            failedCases: [],
          },
          fusionBenchmarkGate: {
            matched: false,
            thresholds: {
              maxScannedRows: 2000,
              maxP95DurationMs: 200,
            },
            failedCases: ['broad agent context text vector fusion query'],
            cases: [
              {
                name: 'broad agent context text vector fusion query',
                hardFiltersBeforeRank: true,
                batchedBroadCandidateJoin: true,
                baselineComparison: {
                  matched: false,
                  failedReasons: ['baseline-p95-regression'],
                },
              },
            ],
          },
          refreshBenchmark: {
            durationMs: 1416,
            plannerStatsDurationMs: 512,
          },
          refresh: {
            rdf3x: {
              plannerStats: {
                analyzedTables: ['rdf_quads', 'rdf3x_graph_stats'],
              },
            },
          },
          coldStartBenchmark: {
            startup: { durationMs: 106 },
            firstQueryAfterRefresh: { durationMs: 402 },
            warmSteadyState: {
              p50DurationMs: 311,
              p95DurationMs: 311,
            },
          },
          storage: {
            factsBytes: 76_349_440,
            derivedBytes: 68_850_314,
            totalBytes: 145_199_754,
            totalToFactsRatio: 1.9,
            pgAcceleration: {
              enabled: true,
              activeOperators: ['join.required_bgp.native'],
            },
          },
          cases: [],
          queryCases: [
            {
              name: 'agent context text vector fusion query',
              physicalPlan: [
                'TextSearch("runtime approvals"@workspace:file://macbook.local/Users/alice/project/)',
                'PostgresNativeFts(TextSearch pg-ts-rank-cd)',
                'PostgresNativeVector(VectorSearch pgvector)',
              ],
            },
          ],
        },
      }),
      'utf8',
    );

    const snapshot = await new RdfBenchmarkReportCatalog({
      roots: [testRoot],
      packageRoot: process.cwd(),
    }).snapshot();

    expect(snapshot.reportCount).toBe(1);
    expect(snapshot.reports[0]).toMatchObject({
      path: path.join('.test-data', 'rdf-benchmark-report-catalog', 'rdf-engine', 'latest', 'models-postgres-2026-06-09T06-45-40-819Z-sample.json'),
      engine: 'postgres-rdf',
      driver: 'pg',
      caseProfile: 'extreme',
      rdfAccelerationProfile: 'pg-hot-operators',
      textSearchBackend: 'pg-native-fts',
      seedQuadCount: 45_656,
      targetQuadCount: 36_000,
      planMatched: true,
      concurrencyMatched: true,
      servingRegressionMatched: true,
      servingRegressionThresholdsConfigured: true,
      failedServingRegressionCases: [],
      fusionBenchmarkMatched: false,
      fusionBenchmarkThresholdsConfigured: true,
      failedFusionBenchmarkCases: ['broad agent context text vector fusion query'],
      fusionBaselineComparisonMatched: false,
      failedFusionBaselineComparisonCases: ['broad agent context text vector fusion query'],
      benchmarkGateConfigSourcesConfigured: true,
      fusionBaselineReportSourceConfigured: true,
      benchmarkGateConfigSourceShapeMismatches: [],
      fusionBaselineReportSourceBaselineProfileConfigured: true,
      fusionHardFiltersBeforeRankCaseCount: 1,
      fusionBatchedBroadCandidateJoinCaseCount: 1,
      nativeTextFtsCaseCount: 1,
      nativeVectorCaseCount: 1,
      ingestDurationMs: 3734,
      copyRows: 65_166,
      copyFallbacks: 0,
      refreshDurationMs: 1416,
      plannerStatsDurationMs: 512,
      plannerStatsAnalyzedTables: ['rdf_quads', 'rdf3x_graph_stats'],
      coldStartDurationMs: 106,
      firstQueryDurationMs: 402,
      warmP50DurationMs: 311,
      warmP95DurationMs: 311,
      storageTotalToFactsRatio: 1.9,
      pgAccelerationEnabled: true,
      pgActiveOperators: ['join.required_bgp.native'],
    });
  });

  it('ignores non-RDF test-data directories when scanning the workspace test-data root', async () => {
    const scanRoot = path.join(testRoot, '.test-data');
    await mkdir(path.join(scanRoot, 'full-runtime'), { recursive: true });
    await writeFile(
      path.join(scanRoot, 'full-runtime', 'models-postgres-2026-06-09T00-00-00-000Z-noise.json'),
      JSON.stringify({ report: { engine: 'postgres-rdf', generatedAt: '2026-06-09T00:00:00.000Z' } }),
      'utf8',
    );

    const snapshot = await new RdfBenchmarkReportCatalog({
      roots: [scanRoot],
      packageRoot: process.cwd(),
    }).snapshot();

    expect(snapshot.reportCount).toBe(0);
  });

  it('summarizes benchmark gate config source shape mismatches from report artifacts', async () => {
    const reportDir = path.join(testRoot, 'rdf-engine', 'shape-mismatch');
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, 'models-postgres-2026-06-09T07-00-00-000Z-shape.json'),
      JSON.stringify({
        seed: {
          driver: 'pg',
          scale: 'large',
          targetQuadCount: 1_000_000,
          seedQuadCount: 1_025_000,
          fullScale: true,
          benchmarkGateConfigSources: [
            {
              kind: 'report-config',
              path: '/tmp/small-report.json',
              seed: {
                driver: 'pglite',
                scale: 'small',
                targetQuads: 48,
                caseProfile: 'all',
              },
            },
          ],
        },
        report: {
          engine: 'postgres-rdf',
          scale: 'large',
          caseProfile: 'all',
          generatedAt: '2026-06-09T07:00:00.000Z',
          failedPlanCases: [],
          cases: [],
          queryCases: [],
        },
      }),
      'utf8',
    );

    const snapshot = await new RdfBenchmarkReportCatalog({
      roots: [testRoot],
      packageRoot: process.cwd(),
    }).snapshot();

    expect(snapshot.reports[0]).toMatchObject({
      benchmarkGateConfigSourcesConfigured: true,
      fusionBaselineReportSourceConfigured: true,
      benchmarkGateConfigSourceShapeMismatches: [
        'source[0].driver expected pg, got pglite',
        'source[0].scale expected large, got small',
        'source[0].targetQuads expected 1000000, got 48',
      ],
    });
  });

  it('treats report-derived benchmark gate sources without seed shape as unauditable', async () => {
    const reportDir = path.join(testRoot, 'rdf-engine', 'missing-source-shape');
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, 'models-postgres-2026-06-09T07-10-00-000Z-missing-source-shape.json'),
      JSON.stringify({
        seed: {
          driver: 'pg',
          scale: 'large',
          targetQuadCount: 1_000_000,
          seedQuadCount: 1_025_000,
          fullScale: true,
          benchmarkGateConfigSources: [
            {
              kind: 'baseline-report',
              path: '/tmp/baseline-without-seed.json',
            },
          ],
        },
        report: {
          engine: 'postgres-rdf',
          scale: 'large',
          caseProfile: 'all',
          generatedAt: '2026-06-09T07:10:00.000Z',
          failedPlanCases: [],
          cases: [],
          queryCases: [],
        },
      }),
      'utf8',
    );

    const snapshot = await new RdfBenchmarkReportCatalog({
      roots: [testRoot],
      packageRoot: process.cwd(),
    }).snapshot();

    expect(snapshot.reports[0]).toMatchObject({
      benchmarkGateConfigSourcesConfigured: true,
      fusionBaselineReportSourceConfigured: true,
      benchmarkGateConfigSourceShapeMismatches: [
        'source[0].seed is missing',
      ],
    });
  });
});
