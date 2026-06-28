import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSparqlPatch,
  documentResourceInput,
  executeRdfTextRebuildCommand,
  resolveSparqlEndpoint,
} from '../../src/cli/commands/rdf';
import { RdfTextIndex } from '../../src/storage/rdf';

describe('rdf command helpers', () => {
  it('strips fragments before fetching or patching the RDF document', () => {
    expect(documentResourceInput('settings/credentials.ttl#cred-openai')).toBe('settings/credentials.ttl');
    expect(documentResourceInput('https://pod.example/alice/settings/credentials.ttl#cred-openai'))
      .toBe('https://pod.example/alice/settings/credentials.ttl');
  });

  it('wraps triple snippets in SPARQL Update operations', () => {
    const sparql = buildSparqlPatch({
      delete: '<s> <p> "old" .',
      insert: '<s> <p> "new" .',
    });

    expect(sparql).toContain('DELETE DATA');
    expect(sparql).toContain('<s> <p> "old" .');
    expect(sparql).toContain('INSERT DATA');
    expect(sparql).toContain('<s> <p> "new" .');
  });

  it('passes through full SPARQL Update text', () => {
    const update = 'PREFIX ex: <https://example.com/> INSERT DATA { ex:s ex:p "v" }';

    expect(buildSparqlPatch({ insert: update })).toBe(update);
  });

  it('resolves Pod-root and scoped SPARQL sidecar endpoints', () => {
    expect(resolveSparqlEndpoint('https://pod.example/alice/'))
      .toBe('https://pod.example/alice/-/sparql');
    expect(resolveSparqlEndpoint('https://pod.example/alice/', 'photos/'))
      .toBe('https://pod.example/alice/photos/-/sparql');
  });

  it('rebuilds a local workspace text index through the RDF ops path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-cli-'));
    try {
      const workspace = path.join(root, 'workspace');
      const textIndexPath = path.join(root, 'rdf-text.sqlite');
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, 'note.md'), '# Alpha\n\nneedle term', 'utf-8');
      await writeFile(path.join(workspace, 'profile.ttl'), '<#me> <https://schema.org/name> "Alice" .', 'utf-8');

      const result = await executeRdfTextRebuildCommand({
        workspace,
        textIndex: textIndexPath,
        reset: true,
      });

      expect(result).toMatchObject({
        scanned: 2,
        indexedTextSources: 2,
        failed: 0,
        resetDerivedIndexes: true,
      });

      const index = new RdfTextIndex({ path: textIndexPath });
      index.open();
      try {
        expect(index.search({ query: 'needle', workspace, limit: 10 }).map((row) => row.localPath))
          .toContain('note.md');
        expect(index.search({ query: 'Alice', workspace, limit: 10 }).map((row) => row.localPath))
          .toContain('profile.ttl');
      } finally {
        index.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rdf postgres models benchmark script helpers', () => {
  it('parses fusion benchmark baseline and threshold files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-cli-'));
    try {
      const configPath = path.join(root, 'fusion-gates.json');
      await writeFile(configPath, JSON.stringify({
        fusionBenchmarkBaselines: {
          'broad agent context text vector fusion query': {
            label: 'p0-p1-p2-physical-source-baseline',
            scannedRows: 10000,
            p95DurationMs: 10000,
          },
        },
        fusionBenchmarkThresholds: {
          maxScannedRows: 500,
          maxP95DurationMs: 250,
        },
        servingRegressionThresholds: {
          maxScannedRows: 1000,
          maxP95DurationMs: 100,
        },
      }), 'utf-8');

      const { parseArgs } = await import('../../scripts/rdf-postgres-models-benchmark');
      const options = parseArgs([
        '--scale=small',
        '--caseProfile=fusion',
        `--benchmarkGateConfig=${configPath}`,
      ]);

      expect(options.fusionBenchmarkBaselines).toEqual({
        'broad agent context text vector fusion query': {
          label: 'p0-p1-p2-physical-source-baseline',
          scannedRows: 10000,
          p95DurationMs: 10000,
        },
      });
      expect(options.fusionBenchmarkThresholds).toEqual({
        maxScannedRows: 500,
        maxP95DurationMs: 250,
      });
      expect(options.servingRegressionThresholds).toEqual({
        maxScannedRows: 1000,
        maxP95DurationMs: 100,
      });
      expect(options.benchmarkGateConfigSources).toEqual([
        {
          kind: 'config',
          path: path.resolve(configPath),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('calibrates per-case benchmark thresholds from a benchmark report artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-threshold-cli-'));
    try {
      const reportPath = path.join(root, 'threshold-report.json');
      await writeFile(reportPath, JSON.stringify({
        report: {
          queryCases: [
            {
              name: 'modeled thread message page query',
              scannedRows: 80,
              p95DurationMs: 10,
            },
            {
              name: 'broad agent context text vector fusion query',
              scannedRows: 160,
              p95DurationMs: 20,
            },
          ],
          servingRegressionGate: {
            enabled: true,
            cases: [
              { name: 'modeled thread message page query' },
            ],
          },
          fusionBenchmarkGate: {
            enabled: true,
            cases: [
              { name: 'broad agent context text vector fusion query' },
            ],
          },
        },
      }), 'utf-8');

      const { parseArgs } = await import('../../scripts/rdf-postgres-models-benchmark');
      const options = parseArgs([
        '--scale=small',
        '--caseProfile=all',
        `--benchmarkGateConfigFromReport=${reportPath}`,
      ]);

      expect(options.servingRegressionThresholds).toEqual({
        cases: {
          'modeled thread message page query': {
            maxScannedRows: 100,
            maxP95DurationMs: 35,
          },
        },
      });
      expect(options.fusionBenchmarkThresholds).toEqual({
        cases: {
          'broad agent context text vector fusion query': {
            maxScannedRows: 200,
            maxP95DurationMs: 45,
          },
        },
      });
      expect(options.fusionBenchmarkBaselines).toEqual({
        'broad agent context text vector fusion query': {
          label: `baseline-report:${path.basename(reportPath)}`,
          scannedRows: 160,
          p95DurationMs: 20,
          maxScannedRows: 200,
          maxP95DurationMs: 45,
        },
      });
      expect(options.benchmarkGateConfigSources).toEqual([
        {
          kind: 'report-config',
          path: path.resolve(reportPath),
          calibratedLimits: true,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects report-derived benchmark gates from a different benchmark shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-shape-cli-'));
    try {
      const reportPath = path.join(root, 'small-report.json');
      await writeFile(reportPath, JSON.stringify({
        seed: {
          driver: 'pglite',
          scale: 'small',
          targetQuads: 48,
          caseProfile: 'all',
        },
        report: {
          queryCases: [
            {
              name: 'broad agent context text vector fusion query',
              scannedRows: 160,
              p95DurationMs: 20,
            },
          ],
          fusionBenchmarkGate: {
            enabled: true,
            cases: [
              { name: 'broad agent context text vector fusion query' },
            ],
          },
        },
      }), 'utf-8');

      const { parseArgs } = await import('../../scripts/rdf-postgres-models-benchmark');

      expect(() => parseArgs([
        '--driver=pglite',
        '--scale=large',
        '--caseProfile=all',
        `--benchmarkGateConfigFromReport=${reportPath}`,
      ])).toThrow(/benchmark gate report shape mismatch: scale expected large, got small; targetQuads expected 1000000, got 48/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses fusion benchmark baselines from a benchmark report artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-baseline-cli-'));
    try {
      const reportPath = path.join(root, 'baseline-report.json');
      await writeFile(reportPath, JSON.stringify({
        seed: {
          driver: 'pglite',
          scale: 'small',
          targetQuads: 48,
          caseProfile: 'fusion',
          rdfAccelerationProfile: 'baseline',
        },
        report: {
          queryCases: [
            {
              name: 'broad agent context text vector fusion query',
              scannedRows: 4096,
              p95DurationMs: 512,
            },
            {
              name: 'serving query that should not become a fusion baseline',
              scannedRows: 10,
              p95DurationMs: 1,
            },
          ],
          fusionBenchmarkGate: {
            enabled: true,
            cases: [
              {
                name: 'broad agent context text vector fusion query',
              },
            ],
          },
        },
      }), 'utf-8');

      const { parseArgs } = await import('../../scripts/rdf-postgres-models-benchmark');
      const options = parseArgs([
        '--scale=small',
        '--caseProfile=fusion',
        `--benchmarkGateBaselineReport=${reportPath}`,
      ]);

      expect(options.fusionBenchmarkBaselines).toEqual({
        'broad agent context text vector fusion query': {
          label: `baseline-report:${path.basename(reportPath)}`,
          scannedRows: 4096,
          p95DurationMs: 512,
        },
      });
      expect(options.benchmarkGateConfigSources).toEqual([
        {
          kind: 'baseline-report',
          path: path.resolve(reportPath),
          seed: {
            driver: 'pglite',
            scale: 'small',
            targetQuads: 48,
            caseProfile: 'fusion',
            rdfAccelerationProfile: 'baseline',
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rdf benchmark report gate script helpers', () => {
  it('parses required serving and fusion gate flags', async () => {
    const { parseArgs } = await import('../../scripts/assert-rdf-benchmark-report-gate');

    const options = parseArgs([
      '--scale=large',
      '--driver=pg',
      '--requireServingRegressionGate',
      '--requireFusionBenchmarkGate',
      '--requireFusionBaselineComparison',
    ]);

    expect(options).toMatchObject({
      requiredScale: 'large',
      requiredDriver: 'pg',
      requireServingRegressionGate: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
    });
  });

  it('parses strict P3 fusion gate as all-profile serving, fusion, and baseline requirements', async () => {
    const { parseArgs } = await import('../../scripts/assert-rdf-benchmark-report-gate');

    const options = parseArgs([
      '--strictP3FusionGate',
    ]);

    expect(options).toMatchObject({
      requiredCaseProfile: 'all',
      minIterations: 3,
      minWarmupIterations: 1,
      requireServingRegressionGate: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireBenchmarkGateConfigSources: true,
      requireFusionBaselineReportSource: true,
      requireFusionBaselineSourceBaselineProfile: true,
      requireFusionHardFilterEvidence: true,
    });
  });

  it('parses product P3 fusion gate as large PG strict gate with batched broad candidate evidence', async () => {
    const { parseArgs } = await import('../../scripts/assert-rdf-benchmark-report-gate');

    const options = parseArgs([
      '--productP3FusionGate',
    ]);

    expect(options).toMatchObject({
      requiredScale: 'large',
      requiredDriver: 'pg',
      requiredCaseProfile: 'all',
      minTargetQuadCount: 1_000_000,
      minSeedQuadCount: 1_000_000,
      minIterations: 3,
      minWarmupIterations: 1,
      minConcurrency: 4,
      requireFullScale: true,
      requireCopyIngest: true,
      requireServingRegressionGate: true,
      requireServingRegressionThresholds: true,
      requireFusionBenchmarkThresholds: true,
      requireFusionBenchmarkGate: true,
      requireFusionBaselineComparison: true,
      requireBenchmarkGateConfigSources: true,
      requireFusionBaselineReportSource: true,
      requireFusionBaselineSourceBaselineProfile: true,
      requireFusionHardFilterEvidence: true,
      requireFusionBatchedBroadCandidateJoinEvidence: true,
    });
  });
});
