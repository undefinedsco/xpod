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
          queryCases: [],
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
      seedQuadCount: 45_656,
      targetQuadCount: 36_000,
      planMatched: true,
      concurrencyMatched: true,
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
});
