import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { inspect } from 'node:util';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import * as benchmark from '../../scripts/native-rdf3x-benchmark';
import {
  buildRdfModelsBenchmarkSeed,
} from '../../src/storage/rdf/models-benchmark';
import {
  buildCloudReplacementTopology,
  type CloudReplacementEngineAdapter,
  type CloudReplacementEngineId,
  type CloudReplacementErrorEvidence,
  type CloudReplacementPgDiagnostics,
  type CloudReplacementWorkload,
} from '../../src/storage/rdf/cloud-replacement-benchmark';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const benchmarkScript = path.join(repositoryRoot, 'scripts/native-rdf3x-benchmark.ts');
const benchmarkModuleUrl = pathToFileURL(benchmarkScript).href;
const resultMarker = '__XPOD_BENCHMARK_TEST_RESULT__';

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync('bun', [ benchmarkScript, ...args ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

const workload: CloudReplacementWorkload = {
  id: 'case-a',
  group: 'short',
  purpose: 'test',
  sparql: 'SELECT ?value WHERE { ?s ?p ?value }',
  sharedSurface: true,
  orderSensitive: false,
  concurrencyRepresentative: true,
};

const largeWorkload: CloudReplacementWorkload = {
  ...workload,
  id: 'case-large',
  group: 'large',
  concurrencyRepresentative: false,
};

const authorizationWorkload: CloudReplacementWorkload = {
  ...workload,
  id: 'case-authorization',
  group: 'authorization',
  concurrencyRepresentative: false,
};

function diagnostics(read: number): CloudReplacementPgDiagnostics {
  return {
    sharedBlocksRead: read,
    sharedBlocksHit: read + 1,
    tempBytes: read + 2,
    memoryPeakBytes: null,
    memoryLimitBytes: null,
    diagnosticsUnavailable: [],
  };
}

function diagnosticsByKey(
  record: benchmark.ConcurrencyRecord,
  read: number,
): [ string, CloudReplacementPgDiagnostics ] {
  return [
    benchmark.benchmarkConcurrencyKey(
      record.cacheMode,
      record.engine,
      record.caseId,
      record.concurrency,
    ),
    diagnostics(read),
  ];
}

function correctnessRecord(correct = true) {
  return {
    correct,
    sameMultiset: correct,
    sameOrder: correct,
    failures: correct ? [] : [ 'mismatch' ],
    rdf3x: {
      rows: [], orderedDigest: '[]', multisetDigest: '[]', fallbackReason: null,
      physicalPlan: [ 'PostgresRdf3x' ], queryElapsedMs: null,
    },
    qlever: {
      rows: [], orderedDigest: '[]', multisetDigest: '[]', fallbackReason: null,
      physicalPlan: [ 'NativeSparql' ], queryElapsedMs: null,
    },
  };
}

function latency(cacheMode: 'off' | 'production', p95Ms: number) {
  return {
    cacheMode,
    coldMs: p95Ms,
    samplesMs: [ p95Ms ],
    p50Ms: p95Ms,
    p95Ms,
    p99Ms: p95Ms,
  };
}

function emptyErrorEvidence(): CloudReplacementErrorEvidence {
  return {
    counts: {
      timeout: 0,
      connection: 0,
      cancelled: 0,
      engine: 0,
      correctness: 0,
      unknown: 0,
    },
    samples: [],
  };
}

function concurrencyRecord(
  overrides: Partial<benchmark.ConcurrencyRecord> & {
    cacheMode: 'off' | 'production';
    engine: CloudReplacementEngineId;
  },
): benchmark.ConcurrencyRecord {
  return {
    cacheMode: overrides.cacheMode,
    caseId: overrides.caseId ?? workload.id,
    engine: overrides.engine,
    concurrency: overrides.concurrency ?? 1,
    durationMs: overrides.durationMs ?? 60_000,
    completed: overrides.completed ?? 1,
    errors: overrides.errors ?? 0,
    infrastructureErrors: overrides.infrastructureErrors ?? 0,
    infrastructureFailure: overrides.infrastructureFailure ?? false,
    errorEvidence: overrides.errorEvidence ?? emptyErrorEvidence(),
    elapsedMs: overrides.elapsedMs ?? 1_000,
    throughputPerSecond: overrides.throughputPerSecond ?? 1,
  };
}

describe('native RDF3X/QLever cloud replacement runner', () => {
  it('requires external execution location and transport while local defaults safely', () => {
    expect(() => benchmark.parseArgs([
      '--mode=external',
      '--executionLocation=cluster',
    ], {
      XPOD_RDF_BENCHMARK_PG_URL: 'postgres://example.test/tenant_benchmark',
    })).toThrow('--transport');
    expect(() => benchmark.parseArgs([
      '--mode=external',
      '--transport=port-forward',
    ], {
      XPOD_RDF_BENCHMARK_PG_URL: 'postgres://example.test/tenant_benchmark',
    })).toThrow('--executionLocation');

    const external = benchmark.parseArgs([
      '--mode=external',
      '--executionLocation=cluster',
      '--transport=port-forward',
    ], {
      XPOD_RDF_BENCHMARK_PG_URL: 'postgres://example.test/tenant_benchmark',
    });
    const local = benchmark.parseArgs([ '--mode=local' ], {});

    expect(external.executionLocation).toBe('cluster');
    expect(external.transport).toBe('port-forward');
    expect(local.executionLocation).toBe('local');
    expect(local.transport).toBe('direct');
  });

  it('documents execution location and transport in CLI help', () => {
    const help = runCli([ '--help' ]);

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--executionLocation=local|cluster');
    expect(help.stdout).toContain('--transport=direct|port-forward');
  });

  it('persists and reloads only matching workload checkpoints', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-checkpoint-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        '--targetQuads=2000000',
        '--iterations=5',
        '--warmupIterations=1',
        '--concurrency=1,8,32',
        '--cacheMode=both',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, context, 'identity-a');
      checkpoint.completedLatencyKeys.push('off:point-lookup');

      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      expect(await benchmark.loadBenchmarkCheckpoint(options, context)).toEqual(checkpoint);
      expect(JSON.parse(await readFile(
        benchmark.benchmarkCheckpointPath(options.out),
        'utf8',
      ))).toEqual(checkpoint);

      const changed = { ...options, iterations: options.iterations + 1 };
      expect(await benchmark.loadBenchmarkCheckpoint(
        changed,
        benchmark.buildBenchmarkExecutionContext(changed, 'database-a'),
      )).toMatchObject({
        completedLatencyKeys: [],
        completedConcurrencyKeys: [],
        latencyRecords: [],
        concurrencyRecords: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not reuse concurrency checkpoints across direct and port-forward contexts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-transport-'));
    try {
      const direct = benchmark.parseArgs([
        '--mode=external',
        '--executionLocation=cluster',
        '--transport=direct',
        `--out=${path.join(root, 'report.json')}`,
      ], { XPOD_RDF_BENCHMARK_PG_URL: 'postgres://example.test/tenant_benchmark' });
      const portForward = benchmark.parseArgs([
        '--mode=external',
        '--executionLocation=cluster',
        '--transport=port-forward',
        `--out=${path.join(root, 'report.json')}`,
      ], { XPOD_RDF_BENCHMARK_PG_URL: 'postgres://example.test/tenant_benchmark' });
      const directContext = benchmark.buildBenchmarkExecutionContext(direct, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(direct, directContext, 'identity-a');
      checkpoint.completedLatencyKeys.push('off:case-a');
      checkpoint.completedConcurrencyKeys.push('off:rdf3x');
      checkpoint.concurrencyRecords.push(concurrencyRecord({ cacheMode: 'off', engine: 'rdf3x' }));
      await benchmark.saveBenchmarkCheckpoint(direct, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(
        portForward,
        benchmark.buildBenchmarkExecutionContext(portForward, 'database-a'),
      );

      expect(loaded?.completedLatencyKeys).toEqual([]);
      expect(loaded?.completedConcurrencyKeys).toEqual([]);
      expect(loaded?.concurrencyRecords).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds cloned report execution contexts for direct and port-forward runs', () => {
    const databaseIdentity = 'a'.repeat(64);
    const workloadIds = [ 'point-lookup', 'message-feed' ];
    const direct = benchmark.buildBenchmarkReportExecutionContext({
      location: 'cluster',
      transport: 'direct',
      databaseIdentity,
      runnerIdentity: 'native-rdf3x-benchmark-v2',
      engineCommit: 'commit-a',
      workloadIds,
    });
    const portForward = benchmark.buildBenchmarkReportExecutionContext({
      location: 'cluster',
      transport: 'port-forward',
      databaseIdentity,
      runnerIdentity: 'native-rdf3x-benchmark-v2',
      engineCommit: 'commit-a',
      workloadIds: [ 'point-lookup', 'message-feed' ],
    });

    expect(direct).toEqual({
      location: 'cluster',
      transport: 'direct',
      databaseIdentity,
      runnerIdentity: 'native-rdf3x-benchmark-v2',
      engineCommit: 'commit-a',
      workloadIds: [ 'point-lookup', 'message-feed' ],
    });
    expect(portForward.transport).toBe('port-forward');
    expect(portForward.workloadIds).toEqual([ 'point-lookup', 'message-feed' ]);
    expect(portForward.workloadIds).not.toBe(direct.workloadIds);
    expect(direct.workloadIds).not.toBe(workloadIds);
    workloadIds.push('mutated-after-build');
    expect(direct.workloadIds).toEqual([ 'point-lookup', 'message-feed' ]);
  });

  it('rejects unsafe report execution context identities without leaking input', () => {
    const unsafeIdentity = 'postgres://user:secret@example.test/raw_database';

    try {
      benchmark.buildBenchmarkReportExecutionContext({
        location: 'cluster',
        transport: 'direct',
        databaseIdentity: unsafeIdentity,
        runnerIdentity: 'native-rdf3x-benchmark-v2',
        engineCommit: 'commit-a',
        workloadIds: [ 'point-lookup' ],
      });
      throw new Error('expected context validation to fail');
    } catch (error) {
      const rendered = `${error instanceof Error ? error.message : String(error)} ${inspect(error)}`;
      expect(rendered).not.toContain(unsafeIdentity);
      expect(rendered).not.toContain('secret');
      expect(rendered).not.toContain('raw_database');
      expect(rendered).toContain('databaseIdentity');
    }
  });

  it('rejects empty or control-character workload ids without leaking input', () => {
    const unsafeWorkload = 'safe-id\nsecret-workload-url=https://example.test';

    for (const workloadIds of [ [], [ unsafeWorkload ] ]) {
      try {
        benchmark.buildBenchmarkReportExecutionContext({
          location: 'cluster',
          transport: 'direct',
          databaseIdentity: 'b'.repeat(64),
          runnerIdentity: 'native-rdf3x-benchmark-v2',
          engineCommit: 'commit-a',
          workloadIds,
        });
        throw new Error('expected context validation to fail');
      } catch (error) {
        const rendered = `${error instanceof Error ? error.message : String(error)} ${inspect(error)}`;
        expect(rendered).not.toContain(unsafeWorkload);
        expect(rendered).not.toContain('secret-workload-url');
        expect(rendered).toContain('workloadIds');
      }
    }
  });

  it('clears all checkpoint evidence when database identity changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-db-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(
        options,
        benchmark.buildBenchmarkExecutionContext(options, 'database-a'),
        'identity-a',
      );
      checkpoint.completedLatencyKeys.push('off:case-a');
      checkpoint.completedConcurrencyKeys.push('off:rdf3x');
      checkpoint.latencyRecords.push({
        cacheMode: 'off',
        workload,
        rdf3x: latency('off', 10),
        qlever: latency('off', 8),
        ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 },
      });
      checkpoint.concurrencyRecords.push(concurrencyRecord({ cacheMode: 'off', engine: 'rdf3x' }));
      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(
        options,
        benchmark.buildBenchmarkExecutionContext(options, 'database-b'),
      );

      expect(loaded?.completedLatencyKeys).toEqual([]);
      expect(loaded?.completedConcurrencyKeys).toEqual([]);
      expect(loaded?.latencyRecords).toEqual([]);
      expect(loaded?.concurrencyRecords).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps latency checkpoints but clears concurrency when only lanes change', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-lanes-'));
    try {
      const base = benchmark.parseArgs([
        '--mode=local',
        '--concurrency=1,8',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const changed = benchmark.parseArgs([
        '--mode=local',
        '--concurrency=1,8,32',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(base, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(base, context, 'identity-a');
      checkpoint.completedLatencyKeys.push('off:case-a');
      checkpoint.completedConcurrencyKeys.push('off:rdf3x');
      checkpoint.latencyRecords.push({
        cacheMode: 'off',
        workload,
        rdf3x: latency('off', 10),
        qlever: latency('off', 8),
        ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 },
      });
      checkpoint.concurrencyRecords.push(concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        concurrency: 8,
        completed: 8,
        throughputPerSecond: 8,
      }));
      await benchmark.saveBenchmarkCheckpoint(base, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(
        changed,
        benchmark.buildBenchmarkExecutionContext(changed, 'database-a'),
      );

      expect(loaded?.completedLatencyKeys).toEqual([ 'off:case-a' ]);
      expect(loaded?.latencyRecords).toHaveLength(1);
      expect(loaded?.completedConcurrencyKeys).toEqual([]);
      expect(loaded?.concurrencyRecords).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses workload and lane in concurrency keys and fingerprints concurrency granularity', () => {
    const options = benchmark.parseArgs([
      '--mode=local',
      '--concurrency=1,8',
    ], {});
    const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
    const fingerprint = JSON.parse(
      benchmark.benchmarkConcurrencyContextFingerprint(options, context),
    );

    expect(benchmark.benchmarkConcurrencyKey(
      'production',
      'rdf3x',
      'latest-message-by-thread',
      32,
    )).toBe('production:rdf3x:latest-message-by-thread:32');
    expect(fingerprint.checkpointGranularity).toBe('workload-concurrency-v1');
  });

  it('drops phase-level concurrency checkpoints while preserving matching latency evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-phase-v2-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        '--concurrency=1,8',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, context, 'identity-a');
      checkpoint.concurrencyContextFingerprint = JSON.stringify({
        ...JSON.parse(checkpoint.concurrencyContextFingerprint),
        checkpointGranularity: 'phase-v2',
      });
      checkpoint.completedLatencyKeys.push('off:case-a');
      checkpoint.completedConcurrencyKeys.push('off:rdf3x');
      checkpoint.latencyRecords.push({
        cacheMode: 'off',
        workload,
        rdf3x: latency('off', 10),
        qlever: latency('off', 8),
        ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 },
      });
      checkpoint.concurrencyRecords.push(concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        concurrency: 8,
      }));
      checkpoint.diagnosticsByCacheMode = { off: { rdf3x: diagnostics(1), qlever: diagnostics(2) } };
      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(options, context);

      expect(loaded?.completedLatencyKeys).toEqual([ 'off:case-a' ]);
      expect(loaded?.latencyRecords).toHaveLength(1);
      expect(loaded?.completedConcurrencyKeys).toEqual([]);
      expect(loaded?.concurrencyRecords).toEqual([]);
      expect(loaded?.diagnosticsByCacheMode).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads only complete non-infrastructure concurrency keys with matching records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-complete-keys-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, context, 'identity-a');
      const goodKey = benchmark.benchmarkConcurrencyKey('off', 'rdf3x', 'case-a', 1);
      const failedKey = benchmark.benchmarkConcurrencyKey('off', 'qlever', 'case-a', 1);
      checkpoint.completedConcurrencyKeys.push(goodKey, failedKey, 'off:rdf3x:missing:8');
      const goodRecord = concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        caseId: 'case-a',
        concurrency: 1,
      });
      const failedRecord = concurrencyRecord({
        cacheMode: 'off',
        engine: 'qlever',
        caseId: 'case-a',
        concurrency: 1,
        infrastructureErrors: 1,
        infrastructureFailure: true,
      });
      checkpoint.concurrencyRecords.push(goodRecord, failedRecord);
      checkpoint.concurrencyDiagnosticsByKey = Object.fromEntries(
        [ diagnosticsByKey(goodRecord, 1), diagnosticsByKey(failedRecord, 2) ],
      );
      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(options, context);

      expect(loaded?.concurrencyRecords).toHaveLength(2);
      expect(loaded?.completedConcurrencyKeys).toEqual([ goodKey ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears concurrency but keeps latency when per-cell diagnostics are missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-missing-cell-diag-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, context, 'identity-a');
      const record = concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        caseId: 'case-a',
        concurrency: 1,
      });
      checkpoint.completedLatencyKeys.push('off:case-a');
      checkpoint.latencyRecords.push({
        cacheMode: 'off',
        workload,
        rdf3x: latency('off', 10),
        qlever: latency('off', 8),
        ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 },
      });
      checkpoint.completedConcurrencyKeys.push(
        benchmark.benchmarkConcurrencyKey('off', 'rdf3x', 'case-a', 1),
      );
      checkpoint.concurrencyRecords.push(record);
      checkpoint.diagnosticsByCacheMode = { off: { rdf3x: diagnostics(999), qlever: diagnostics(2) } };
      delete (checkpoint as Partial<benchmark.BenchmarkCheckpoint>).concurrencyDiagnosticsByKey;
      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(options, context);

      expect(loaded?.completedLatencyKeys).toEqual([ 'off:case-a' ]);
      expect(loaded?.latencyRecords).toHaveLength(1);
      expect(loaded?.completedConcurrencyKeys).toEqual([]);
      expect(loaded?.concurrencyRecords).toEqual([]);
      expect(loaded?.concurrencyDiagnosticsByKey).toEqual({});
      expect(loaded?.diagnosticsByCacheMode).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds checkpoint aggregate diagnostics from per-cell diagnostics instead of trusting saved aggregate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-rebuild-diag-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, context, 'identity-a');
      const first = concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        caseId: 'case-a',
        concurrency: 1,
      });
      const second = concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        caseId: 'case-b',
        concurrency: 1,
      });
      checkpoint.concurrencyRecords.push(first, second);
      checkpoint.completedConcurrencyKeys.push(
        benchmark.benchmarkConcurrencyKey('off', 'rdf3x', 'case-a', 1),
        benchmark.benchmarkConcurrencyKey('off', 'rdf3x', 'case-b', 1),
      );
      checkpoint.concurrencyDiagnosticsByKey = Object.fromEntries([
        diagnosticsByKey(first, 10),
        diagnosticsByKey(second, 3),
      ]);
      checkpoint.diagnosticsByCacheMode = { off: { rdf3x: diagnostics(999), qlever: diagnostics(2) } };
      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(options, context);

      expect(loaded?.completedConcurrencyKeys).toHaveLength(2);
      expect(loaded?.diagnosticsByCacheMode.off?.rdf3x.sharedBlocksRead).toBe(13);
      expect(loaded?.diagnosticsByCacheMode.off?.rdf3x.sharedBlocksHit).toBe(15);
      expect(loaded?.diagnosticsByCacheMode.off?.qlever).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps matching latency evidence but drops stale v2 concurrency records missing error evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-v2-stale-concurrency-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        '--concurrency=1,8',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      const context = benchmark.buildBenchmarkExecutionContext(options, 'database-a');
      const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, context, 'identity-a');
      checkpoint.completedLatencyKeys.push('off:case-a');
      checkpoint.completedConcurrencyKeys.push('off:rdf3x');
      checkpoint.latencyRecords.push({
        cacheMode: 'off',
        workload,
        rdf3x: latency('off', 10),
        qlever: latency('off', 8),
        ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 },
      });
      checkpoint.correctnessRecords.push({
        cacheMode: 'off',
        caseId: workload.id,
        correctness: {
          correct: true,
          sameMultiset: true,
          sameOrder: true,
          failures: [],
          rdf3x: {
            rows: [],
            orderedDigest: '[]',
            multisetDigest: '[]',
            fallbackReason: null,
            physicalPlan: [],
            queryElapsedMs: null,
          },
          qlever: {
            rows: [],
            orderedDigest: '[]',
            multisetDigest: '[]',
            fallbackReason: null,
            physicalPlan: [],
            queryElapsedMs: null,
          },
        },
      });
      checkpoint.correctnessFailures.push('off:case-a:existing-failure');
      checkpoint.concurrencyRecords.push({
        cacheMode: 'off',
        caseId: 'case-a',
        engine: 'rdf3x',
        concurrency: 8,
        durationMs: 60_000,
        completed: 8,
        errors: 0,
        elapsedMs: 1_000,
        throughputPerSecond: 8,
      } as unknown as benchmark.ConcurrencyRecord);
      checkpoint.diagnosticsByCacheMode = { off: { rdf3x: diagnostics(1), qlever: diagnostics(2) } };
      await benchmark.saveBenchmarkCheckpoint(options, checkpoint);

      const loaded = await benchmark.loadBenchmarkCheckpoint(options, context);

      expect(loaded?.completedLatencyKeys).toEqual([ 'off:case-a' ]);
      expect(loaded?.latencyRecords).toHaveLength(1);
      expect(loaded?.correctnessRecords).toHaveLength(1);
      expect(loaded?.correctnessFailures).toEqual([ 'off:case-a:existing-failure' ]);
      expect(loaded?.completedConcurrencyKeys).toEqual([]);
      expect(loaded?.concurrencyRecords).toEqual([]);
      expect(loaded?.diagnosticsByCacheMode).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects version 1 checkpoints instead of migrating ambiguous evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-benchmark-v1-'));
    try {
      const options = benchmark.parseArgs([
        '--mode=local',
        `--out=${path.join(root, 'report.json')}`,
      ], {});
      await benchmark.saveBenchmarkCheckpoint(options, {
        version: 1,
        fingerprint: 'legacy',
        identityId: 'identity-a',
        completedLatencyKeys: [ 'off:case-a' ],
        completedConcurrencyPhases: [ 'off:rdf3x' ],
        latencyRecords: [],
        concurrencyRecords: [],
        correctnessRecords: [],
        correctnessFailures: [],
        diagnosticsByCacheMode: {},
      } as unknown as benchmark.BenchmarkCheckpoint);

      expect(await benchmark.loadBenchmarkCheckpoint(
        options,
        benchmark.buildBenchmarkExecutionContext(options, 'database-a'),
      )).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hashes PostgreSQL system identity without leaking raw database identifiers', async () => {
    const queries: string[] = [];
    const identity = await benchmark.collectBenchmarkDatabaseIdentity({
      async query<T>(sql: string) {
        queries.push(sql);
        return { rows: [ {
          system_identifier: '123456789012345678',
          database_name: 'tenant_benchmark',
        } as T ] };
      },
    });

    expect(queries).toEqual([
      'SELECT (pg_control_system()).system_identifier::text AS system_identifier, current_database() AS database_name',
    ]);
    expect(identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity).not.toContain('123456789012345678');
    expect(identity).not.toContain('tenant_benchmark');
  });

  it('fails closed when PostgreSQL system identity is unavailable', async () => {
    let caught: unknown;
    try {
      await benchmark.collectBenchmarkDatabaseIdentity({
        async query() {
          throw new Error(
            'permission denied for function pg_control_system against ' +
            'postgres://user:top-secret@example.test/tenant_benchmark password=hunter2',
          );
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    const directlyRendered = `${message}\n${JSON.stringify(caught)}\n${inspect(caught)}`;
    expect(directlyRendered).toContain('pg_control_system');
    expect(directlyRendered).not.toContain('postgres://');
    expect(directlyRendered).not.toContain('user');
    expect(directlyRendered).not.toContain('top-secret');
    expect(directlyRendered).not.toContain('example.test');
    expect(directlyRendered).not.toContain('password=');
    expect(directlyRendered).not.toContain('hunter2');
  });

  it('documents the safe CLI without accepting a connection URL argument', () => {
    const help = runCli([ '--help' ]);

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--mode=local|external');
    expect(help.stdout).toContain('--targetQuads=N');
    expect(help.stdout).toContain('--iterations=20');
    expect(help.stdout).toContain('--warmupIterations=3');
    expect(help.stdout).toContain('--concurrency=1,8,32');
    expect(help.stdout).toContain('--cacheMode=off|production|both');
    expect(help.stdout).toContain('--operationTimeoutMs=30000');
    expect(help.stdout).toContain('--image=xpod-rdf-postgres:pg17-smoke');
    expect(help.stdout).toContain('--out=.test-data/rdf-engine-perf-reports/');
    expect(help.stdout).toContain('XPOD_RDF_BENCHMARK_PG_URL');
    expect(help.stdout).not.toContain('--connectionString');
    expect(help.stdout).not.toMatch(/postgres(?:ql)?:\/\//u);
  });

  it('imports without running the CLI or provisioning infrastructure', () => {
    const expression = `
      const benchmark = await import(${JSON.stringify(benchmarkModuleUrl)});
      process.stdout.write(${JSON.stringify(resultMarker)} + JSON.stringify(Object.keys(benchmark)));
    `;
    const imported = spawnSync('bun', [ '--eval', expression ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, XPOD_RDF_BENCHMARK_PG_URL: undefined },
      timeout: 30_000,
    });

    expect(imported.status, imported.stderr || imported.stdout).toBe(0);
    expect(imported.stdout.slice(0, imported.stdout.indexOf(resultMarker))).toBe('');
    expect(imported.stderr).toBe('');
    const exports = JSON.parse(imported.stdout.slice(
      imported.stdout.indexOf(resultMarker) + resultMarker.length,
    ));
    expect(exports).toEqual(expect.arrayContaining([
      'assertDedicatedBenchmarkDatabase',
      'benchmarkCleanupSql',
      'parseArgs',
    ]));
  });

  it('reads external database configuration only from the dedicated environment key', () => {
    const url = 'postgres://user:secret@example.test/tenant_benchmark';
    const parsed = benchmark.parseArgs(
      [
        '--mode=external',
        '--executionLocation=cluster',
        '--transport=direct',
        '--targetQuads=2000000',
      ],
      {
        XPOD_RDF_BENCHMARK_PG_URL: url,
        CONNECTION_STRING: 'postgres://admin:production@example.test/xpod',
      },
    );

    expect(parsed.databaseName).toBe('tenant_benchmark');
    expect(() => benchmark.parseArgs([
      '--mode=external',
      '--executionLocation=cluster',
      '--transport=direct',
    ], {
      CONNECTION_STRING: url,
    })).toThrow('XPOD_RDF_BENCHMARK_PG_URL');
    expect(() => benchmark.parseArgs([ `--connectionString=${url}` ], {}))
      .toThrow('Unknown option');
  });

  it('keeps raw external database names out of checkpoint fingerprints', () => {
    const options = benchmark.parseArgs([
      '--mode=external',
      '--executionLocation=cluster',
      '--transport=direct',
    ], {
      XPOD_RDF_BENCHMARK_PG_URL:
        'postgres://operator:top-secret@example.test/tenant_benchmark',
    });
    const context = benchmark.buildBenchmarkExecutionContext(options, 'a'.repeat(64));
    const fingerprints = [
      benchmark.benchmarkLatencyContextFingerprint(options, context),
      benchmark.benchmarkConcurrencyContextFingerprint(options, context),
    ].join('\n');

    expect(fingerprints).not.toContain('tenant_benchmark');
    expect(fingerprints).not.toContain('top-secret');
  });

  it('adds the dedicated benchmark search path to external PostgreSQL URLs', () => {
    const raw = 'postgresql://user:secret@example.test/tenant_benchmark?sslmode=require';
    const connection = benchmark.buildExternalBenchmarkConnectionString(raw);
    const parsed = new URL(connection);

    expect(parsed.protocol).toBe('postgresql:');
    expect(parsed.pathname).toBe('/tenant_benchmark');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
    expect(parsed.searchParams.getAll('options')).toEqual([
      '-csearch_path=xpod_benchmark,public',
    ]);
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('secret');
  });

  it('merges existing external PostgreSQL options without changing credentials', () => {
    const raw = 'postgres://operator:p%40ss%20word@example.test/tenant_benchmark' +
      '?sslmode=verify-full&options=-cstatement_timeout%3D5000&application_name=bench';
    const connection = benchmark.buildExternalBenchmarkConnectionString(raw);
    const parsed = new URL(connection);

    expect(connection).not.toContain('p@ss word');
    expect(parsed.protocol).toBe('postgres:');
    expect(parsed.pathname).toBe('/tenant_benchmark');
    expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
    expect(parsed.searchParams.get('application_name')).toBe('bench');
    expect(parsed.username).toBe('operator');
    expect(parsed.password).toBe('p%40ss%20word');
    expect(parsed.searchParams.getAll('options')).toEqual([
      '-cstatement_timeout=5000 -csearch_path=xpod_benchmark,public',
    ]);
  });

  it('does not modify local benchmark PostgreSQL URLs', () => {
    const local = 'postgres://postgres@127.0.0.1:5432/xpod_benchmark';

    expect(benchmark.buildLocalBenchmarkConnectionString(local)).toBe(local);
  });

  it('does not echo the external URL when CLI database validation fails', () => {
    const productionUrl = 'postgres://operator:top-secret@example.test/xpod';
    const failed = runCli([
      '--mode=external',
      '--executionLocation=cluster',
      '--transport=direct',
      '--dry-run',
    ], {
      XPOD_RDF_BENCHMARK_PG_URL: productionUrl,
    });

    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('dedicated benchmark database');
    expect(failed.stderr).not.toContain(productionUrl);
    expect(failed.stderr).not.toContain('top-secret');
  });

  it('allows only decoded dedicated PostgreSQL benchmark database names', () => {
    expect(benchmark.assertDedicatedBenchmarkDatabase(
      'postgres://user:secret@example.test/xpod_benchmark',
    )).toBe('xpod_benchmark');
    expect(benchmark.assertDedicatedBenchmarkDatabase(
      'postgresql://example.test/encoded%5Fbenchmark',
    )).toBe('encoded_benchmark');

    for (const input of [
      'http://example.test/xpod_benchmark',
      'postgres://example.test',
      'postgres://example.test/',
      'postgres://example.test//tenant_benchmark',
      'postgres://user:secret@example.test/xpod',
      'postgres://user:secret@example.test/production',
    ]) {
      expect(() => benchmark.assertDedicatedBenchmarkDatabase(input))
        .toThrow('dedicated benchmark database');
    }
  });

  it('generates exactly the two cleanup statements after repeating the database assertion', () => {
    expect(benchmark.benchmarkCleanupSql(
      'postgres://user:secret@example.test/xpod_benchmark',
    )).toEqual([
      'DROP SCHEMA IF EXISTS xpod_benchmark CASCADE',
      'CREATE SCHEMA xpod_benchmark',
    ]);
    expect(() => benchmark.benchmarkCleanupSql(
      'postgres://user:secret@example.test/xpod',
    )).toThrow('dedicated benchmark database');
  });

  it('rolls back an atomic external cleanup when schema recreation fails', async () => {
    const createFailure = new Error('CREATE schema failed');
    const calls: string[] = [];
    let schemaExists = true;
    let schemaBeforeTransaction = true;
    let releases = 0;
    const client = {
      async query(statement: string) {
        calls.push(statement);
        if (statement === 'BEGIN') {
          schemaBeforeTransaction = schemaExists;
        } else if (statement === 'DROP SCHEMA IF EXISTS xpod_benchmark CASCADE') {
          schemaExists = false;
        } else if (statement === 'CREATE SCHEMA xpod_benchmark') {
          throw createFailure;
        } else if (statement === 'ROLLBACK') {
          schemaExists = schemaBeforeTransaction;
        }
      },
      release() { releases += 1; },
    };

    await expect(benchmark.executeBenchmarkCleanup({
      async connect() { return client; },
    }, 'postgres://example.test/tenant_benchmark')).rejects.toBe(createFailure);

    expect(calls).toEqual([
      'BEGIN',
      'DROP SCHEMA IF EXISTS xpod_benchmark CASCADE',
      'CREATE SCHEMA xpod_benchmark',
      'ROLLBACK',
    ]);
    expect(schemaExists).toBe(true);
    expect(releases).toBe(1);
  });

  it('preserves both schema recreation and rollback failures', async () => {
    const createFailure = new Error('CREATE schema failed');
    const rollbackFailure = new Error('ROLLBACK failed');
    let releases = 0;
    const client = {
      async query(statement: string) {
        if (statement === 'CREATE SCHEMA xpod_benchmark') {
          throw createFailure;
        }
        if (statement === 'ROLLBACK') {
          throw rollbackFailure;
        }
      },
      release() { releases += 1; },
    };
    let caught: unknown;
    try {
      await benchmark.executeBenchmarkCleanup({
        async connect() { return client; },
      }, 'postgres://example.test/tenant_benchmark');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([ createFailure, rollbackFailure ]);
    expect(releases).toBe(1);
  });

  it('renders recursive CLI aggregate causes without leaking connection sentinels', () => {
    const url = 'postgres://operator:top-secret@private-db.invalid/tenant_benchmark';
    const failure = new AggregateError([
      new Error(`load category failed against ${url}`),
      new AggregateError([
        new Error('rollback refused by private-db.invalid password=hunter2'),
      ], 'rollback category failed'),
    ], 'Benchmark failed and cleanup also failed');

    const rendered = benchmark.formatBenchmarkCliFailure(failure, url);

    expect(rendered).toContain('RDF cloud replacement benchmark failed:');
    expect(rendered).toMatch(/primary: load category failed/iu);
    expect(rendered).toMatch(/cleanup\[1\]: rollback category failed/iu);
    expect(rendered).toMatch(/cleanup\[1\]\.cause\[1\]: rollback refused/iu);
    for (const secret of [
      url,
      'postgres://',
      'operator',
      'top-secret',
      'private-db.invalid',
      'hunter2',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('redacts the raw database name from PostgreSQL driver errors', () => {
    const url = 'postgres://operator:top-secret@private-db.invalid/tenant_benchmark';
    const rendered = benchmark.formatBenchmarkCliFailure(
      new Error('database "tenant_benchmark" does not exist'),
      url,
    );

    expect(rendered).toContain('database "[redacted connection sentinel]" does not exist');
    expect(rendered).not.toContain('tenant_benchmark');
  });

  it.each([
    [ '--mode=cloud', 'mode' ],
    [ '--targetQuads=0', 'targetQuads' ],
    [ '--targetQuads=1oops', 'targetQuads' ],
    [ '--iterations=-1', 'iterations' ],
    [ '--warmupIterations=1.5', 'warmupIterations' ],
    [ '--concurrency=1,2', 'concurrency' ],
    [ '--concurrency=1,1', 'concurrency' ],
    [ '--cacheMode=disabled', 'cacheMode' ],
    [ '--operationTimeoutMs=0', 'operationTimeoutMs' ],
    [ '--operationTimeoutMs=Infinity', 'operationTimeoutMs' ],
  ])('rejects invalid option %s without echoing values', (argument, expectedName) => {
    expect(() => benchmark.parseArgs([ argument ], {})).toThrow(expectedName);
  });

  it('prints fixed gates and a credential-free dry-run safety plan', () => {
    const dryRun = runCli([ '--dry-run', '--mode=local', '--targetQuads=20000' ]);

    expect(dryRun.status, dryRun.stderr).toBe(0);
    const plan = JSON.parse(dryRun.stdout);
    expect(Number(plan.buildSetupTimeoutMs) > Number(plan.operationTimeoutMs)).toBe(true);
    expect(plan).toMatchObject({
      mode: 'local',
      targetQuads: 20_000,
      operationTimeoutMs: 30_000,
      buildSetupTimeoutMs: benchmark.BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
      concurrencyDurationMs: 60_000,
      engines: {
        rdf3x: {
          nativeSparqlEnabled: false,
          compatibilityFallback: false,
          cancellation: 'server-statement-timeout-plus-prompt-client-race',
        },
        qlever: {
          nativeSparqlEnabled: true,
          compatibilityFallback: false,
          cancellation: 'native-abort-signal-plus-server-statement-timeout',
        },
      },
      loading: { syntheticPodCount: 32, messagesPerBatch: 10_000 },
      evidenceModes: {
        latency: 'production',
        concurrencyAndGates: 'off',
      },
      weights: { short: 0.60, large: 0.30, authorization: 0.10 },
      safety: {
        connectionSource: 'disposable-local-container',
        cleanup: 'remove-container',
      },
    });
    expect(JSON.stringify(plan)).not.toMatch(
      /postgres(?:ql)?:\/\/|connectionString|password|apiKey|secret/iu,
    );
  });

  it('keeps the raw external database name out of the dry-run plan', () => {
    const dryRun = runCli([
      '--dry-run',
      '--mode=external',
      '--executionLocation=cluster',
      '--transport=direct',
    ], {
      XPOD_RDF_BENCHMARK_PG_URL:
        'postgres://operator:top-secret@example.test/tenant_benchmark',
    });

    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).not.toContain('tenant_benchmark');
    expect(JSON.parse(dryRun.stdout).safety).toEqual({
      connectionSource: 'XPOD_RDF_BENCHMARK_PG_URL',
      databaseGuard: 'decoded-name-ends-with-_benchmark',
      cleanup: 'drop-and-recreate-xpod_benchmark-schema',
    });
  });

  it('selects bounded loading plans at the required pod-count thresholds', () => {
    const plans = [ 1_999_999, 2_000_000, 9_999_999, 10_000_000 ]
      .map((target) => benchmark.buildBenchmarkLoadingPlan(target));

    expect(plans.map((plan) => plan.syntheticPodCount)).toEqual([ 32, 128, 128, 512 ]);
    expect(plans.every((plan) => plan.messagesPerBatch === 10_000)).toBe(true);
    expect(plans.every((plan) => plan.maxBatchQuads <= 90_000)).toBe(true);
  });

  it('uses persisted fact counts, bounded batches, and a strict load-wave cap', async () => {
    const emittedBaseFacts = buildRdfModelsBenchmarkSeed({
      syntheticMessages: 0,
      syntheticPodCount: 32,
      caseProfile: 'default',
    }).length + buildCloudReplacementTopology(32).length;
    const targetFacts = emittedBaseFacts + 45;
    const puts: number[] = [];
    const persisted = new Set<string>();
    let emittedFacts = 0;
    let duplicateFacts = 0;
    let factCountCalls = 0;
    let firstObservedFacts = 0;
    const quadKey = (quad: any): string => JSON.stringify([
      quad.subject.termType,
      quad.subject.value,
      quad.predicate.value,
      quad.object.termType,
      quad.object.value,
      quad.object.language,
      quad.object.datatype?.value,
      quad.graph.termType,
      quad.graph.value,
    ]);
    const reportedFacts = await benchmark.loadBenchmarkFacts({
      put(input) {
        const quads = Array.isArray(input) ? input : [ input ];
        puts.push(quads.length);
        emittedFacts += quads.length;
        for (const quad of quads) {
          const key = quadKey(quad);
          if (persisted.has(key)) {
            duplicateFacts += 1;
          }
          persisted.add(key);
        }
      },
    }, targetFacts, {
      messagesPerBatch: 2,
      factCount() {
        factCountCalls += 1;
        if (factCountCalls === 1) {
          firstObservedFacts = persisted.size;
        }
        return factCountCalls === 2 ? firstObservedFacts : persisted.size;
      },
    });

    expect(duplicateFacts).toBeGreaterThan(0);
    expect(reportedFacts).toBe(persisted.size);
    expect(reportedFacts).toBeGreaterThanOrEqual(targetFacts);
    expect(emittedFacts).toBeGreaterThan(reportedFacts);
    expect(factCountCalls).toBeGreaterThanOrEqual(3);
    expect(factCountCalls).toBeLessThan(puts.length);
    expect(puts.slice(2).every((count) => count <= 18)).toBe(true);

    await expect(benchmark.loadBenchmarkFacts({ put() {} }, 1, {
      messagesPerBatch: 1,
      factCount: () => 0,
    })).rejects.toThrow(/1 facts below target.*load waves/iu);
  });

  it('counts facts with the direct exact rdf_quads COUNT query', async () => {
    const queries: string[] = [];
    const count = await benchmark.countBenchmarkFacts({
      async query<T>(sql: string) {
        queries.push(sql);
        return { rows: [ { count: '12345' } as unknown as T ] };
      },
    });

    expect(count).toBe(12_345);
    expect(queries).toEqual([ 'SELECT COUNT(*) FROM rdf_quads' ]);
  });

  it('records true cold samples before correctness and ignores helper cold', async () => {
    const events: string[] = [];
    const calls = { rdf3x: 0, qlever: 0 };
    const adapter = <Id extends 'rdf3x' | 'qlever'>(
      id: Id,
    ): CloudReplacementEngineAdapter<Id> => ({
      id,
      async execute(_workload: unknown, sampleIdentity?: string) {
        calls[id] += 1;
        events.push(`${id}:${calls[id]}:${sampleIdentity ? 'sampled' : 'correctness'}`);
        return {
          rows: [],
          orderedDigest: '[]',
          multisetDigest: '[]',
          fallbackReason: null,
          physicalPlan: [ id ],
          queryElapsedMs: calls[id] * 10 + (id === 'rdf3x' ? 1 : 2),
        };
      },
    });
    let identity = 0;
    const result = await benchmark.measureCloudReplacementCaseWithTrueCold(
      workload,
      adapter('rdf3x'),
      adapter('qlever'),
      {
        prepareColdState: async () => { events.push('prepare-cold'); },
        warmupIterations: 0,
        iterations: 1,
        coldFirstEngine: 'qlever',
        operationTimeoutMs: 100,
        cacheMode: 'off',
        identitySource: {
          next(engine) {
            identity += 1;
            return `# identity:${engine}:${identity}`;
          },
        },
      },
    );

    expect(events.slice(0, 3)).toEqual([
      'prepare-cold',
      'qlever:1:sampled',
      'rdf3x:1:sampled',
    ]);
    expect(events[3]).toContain('rdf3x:2:correctness');
    expect(events[4]).toContain('qlever:2:correctness');
    expect(result.rdf3x.coldMs).toBe(11);
    expect(result.qlever.coldMs).toBe(12);
    expect(result.ignoredSteadyHelperColdMs).toEqual({ rdf3x: 31, qlever: 32 });
  });

  it('records a timed-out engine as censored evidence and still measures its baseline', async () => {
    let rdf3xCalls = 0;
    const rdf3x: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        rdf3xCalls += 1;
        return {
          rows: [], orderedDigest: '[]', multisetDigest: '[]',
          fallbackReason: null, physicalPlan: [ 'rdf3x' ], queryElapsedMs: rdf3xCalls,
        };
      },
    };
    const qlever: CloudReplacementEngineAdapter<'qlever'> = {
      id: 'qlever',
      async execute() {
        throw new benchmark.BenchmarkEngineExecutionError(
          'qlever',
          new DOMException('timed out', 'TimeoutError'),
        );
      },
    };
    let identities = 0;

    const result = await benchmark.measureCloudReplacementCaseWithTimeoutEvidence(
      workload,
      rdf3x,
      qlever,
      {
        prepareColdState() {},
        warmupIterations: 0,
        iterations: 2,
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 100,
        cacheMode: 'off',
        identitySource: { next: () => `# identity:${++identities}` },
      },
    );

    expect(result.correctness.correct).toBe(false);
    expect(result.correctness.failures).toContain('qlever-timeout:100ms');
    expect(result.correctness.failures).not.toContain('qlever-cancel:100ms');
    // The failed paired attempt already consumed one RDF3X cold sample. The
    // surviving engine is then measured again from a freshly prepared state.
    expect(result.rdf3x.samplesMs).toEqual([ 3, 4 ]);
    expect(result.qlever.samplesMs).toEqual([ 100, 100 ]);
    expect(result.qlever.p95Ms).toBe(100);
  });

  it('records both engines when the surviving baseline also times out', async () => {
    const timedOut = (engine: 'rdf3x' | 'qlever'): CloudReplacementEngineAdapter<typeof engine> => ({
      id: engine,
      async execute() {
        throw new benchmark.BenchmarkEngineExecutionError(
          engine,
          new DOMException('timed out', 'TimeoutError'),
        );
      },
    });

    const result = await benchmark.measureCloudReplacementCaseWithTimeoutEvidence(
      workload,
      timedOut('rdf3x'),
      timedOut('qlever'),
      {
        prepareColdState() {},
        warmupIterations: 0,
        iterations: 2,
        coldFirstEngine: 'qlever',
        operationTimeoutMs: 100,
        cacheMode: 'off',
        identitySource: { next: () => '# identity' },
      },
    );

    expect(result.correctness.failures).toEqual([
      'qlever-timeout:100ms',
      'rdf3x-timeout:100ms',
    ]);
    expect(result.rdf3x.samplesMs).toEqual([ 100, 100 ]);
    expect(result.qlever.samplesMs).toEqual([ 100, 100 ]);
  });

  it('attributes timeout errors raised by the paired measurement helper', () => {
    expect(benchmark.benchmarkTimeoutEngine(
      new DOMException(
        'Cloud replacement rdf3x operation timed out after 100ms',
        'TimeoutError',
      ),
    )).toBe('rdf3x');
    expect(benchmark.benchmarkTimeoutEngine(
      new Error('Cloud replacement qlever operation timeout exceeded'),
    )).toBe('qlever');
  });

  it('passes timeout and signal to raw engines and times only materialization', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const fake = (marker: string): benchmark.BenchmarkSparqlEngine => ({
      async queryBindings(query, basePath, accessScope, options) {
        calls.push({
          query,
          basePath,
          accessScope,
          signal: options?.signal instanceof AbortSignal,
          timeoutMs: options?.timeoutMs,
        });
        return (async function* () {
          events.push('materialize');
          yield new Map([[ 'value', DataFactory.literal('ok') ]]);
        })();
      },
      getMetrics() {
        events.push('metrics');
        return {
          fallbackCount: 0,
          lastPrimary: { operation: 'queryBindings', plan: [ marker ], indexChoices: [] },
        };
      },
    });
    const clock = () => {
      events.push('clock');
      return events.filter((event) => event === 'clock').length === 1 ? 10 : 25;
    };
    const rdf3x = await benchmark.createCloudReplacementAdapter(
      'rdf3x', fake('PostgresRdf3x'), { now: clock, operationTimeoutMs: 4_321 },
    ).execute(workload, '# sample:rdf3x');
    const qlever = await benchmark.createCloudReplacementAdapter(
      'qlever', fake('NativeSparql'), { now: () => 40, operationTimeoutMs: 4_321 },
    ).execute(workload);

    expect(rdf3x).toMatchObject({ queryElapsedMs: 15, physicalPlan: [ 'PostgresRdf3x' ] });
    expect(qlever).toMatchObject({ queryElapsedMs: null, physicalPlan: [ 'NativeSparql' ] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ signal: true, timeoutMs: 4_321 });
    expect(calls[1]).toMatchObject({ signal: true, timeoutMs: 4_321 });
    expect(events.slice(0, 4)).toEqual([ 'clock', 'materialize', 'clock', 'metrics' ]);
  });

  it('attributes wrapped adapter failures to query and materialize stages', async () => {
    const queryFailure = new Error('query failed');
    const queryEngine: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() {
        throw queryFailure;
      },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastPrimary: { operation: 'queryBindings', plan: [ 'NativeSparql' ], indexChoices: [] },
        };
      },
    };
    const materializeEngine: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() {
        return (async function* () {
          yield 'not a binding';
        })();
      },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastPrimary: { operation: 'queryBindings', plan: [ 'NativeSparql' ], indexChoices: [] },
        };
      },
    };

    await expect(benchmark.createCloudReplacementAdapter(
      'qlever', queryEngine,
    ).execute(workload, '# timed')).rejects.toMatchObject({
      stage: 'query',
      cause: queryFailure,
    });
    await expect(benchmark.createCloudReplacementAdapter(
      'qlever', materializeEngine,
    ).execute(workload, '# timed')).rejects.toMatchObject({
      stage: 'materialize',
    });
  });

  it('preserves cancel and timeout stages in BenchmarkEngineExecutionError wrappers', async () => {
    const aborted = new AbortController();
    aborted.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(benchmark.createCloudReplacementAdapter(
      'qlever',
      {
        async queryBindings() {
          return (async function* () {})();
        },
        getMetrics() {
          return {
            fallbackCount: 0,
            lastPrimary: { operation: 'queryBindings', plan: [ 'NativeSparql' ], indexChoices: [] },
          };
        },
      },
      { operationTimeoutMs: 1_000 },
    ).execute(workload, '# timed', aborted.signal)).rejects.toMatchObject({
      stage: 'cancel',
      name: 'AbortError',
    });

    const neverResolves: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() {
        return new Promise<unknown>(() => {});
      },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastPrimary: { operation: 'queryBindings', plan: [ 'NativeSparql' ], indexChoices: [] },
        };
      },
    };
    await expect(benchmark.createCloudReplacementAdapter(
      'qlever',
      neverResolves,
      { operationTimeoutMs: 5 },
    ).execute(workload, '# timed')).rejects.toMatchObject({
      stage: 'query',
      name: 'TimeoutError',
    });
  });

  it.each([
    'Rdf3xPermutationScan(SPO)',
    'Rdf3xPermutationScan(SOP)',
    'Rdf3xPermutationScan(PSO)',
    'Rdf3xPermutationScan(POS)',
    'Rdf3xPermutationScan(OSP)',
    'Rdf3xPermutationScan(OPS)',
    'Rdf3xMembershipScan',
  ])('accepts the real RDF3X physical primary marker %s', async (marker) => {
    const engine: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() { return (async function* () {})(); },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastPrimary: { operation: 'queryBindings', plan: [ marker ], indexChoices: [] },
        };
      },
    };

    await expect(benchmark.createCloudReplacementAdapter(
      'rdf3x', engine,
    ).execute(workload, '# timed')).resolves.toMatchObject({
      fallbackReason: null,
      physicalPlan: [ marker ],
    });
  });

  it.each([
    'Rdf3xPermutationScan',
    'Rdf3xPermutationScan()',
    'Rdf3xPermutationScan(GSP)',
    'Rdf3xPermutationScan(SPO)Suffix',
    'Rdf3xPermutationScan(SPO) trailing',
    'Rdf3xMembershipScanSuffix',
    'Rdf3xMembershipScan trailing',
    'FakePostgresRdf3x',
  ])('rejects malformed or unrelated RDF3X marker %s', async (marker) => {
    const engine: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() { return (async function* () {})(); },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastPrimary: { operation: 'queryBindings', plan: [ marker ], indexChoices: [] },
        };
      },
    };

    await expect(benchmark.createCloudReplacementAdapter(
      'rdf3x', engine,
    ).execute(workload, '# timed')).rejects.toThrow('selected engine');
  });

  it('rejects a wrong QLever plan even when no fallback is recorded', async () => {
    const engine: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() { return (async function* () {})(); },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastPrimary: {
            operation: 'queryBindings',
            plan: [ 'Rdf3xPermutationScan(SPO)' ],
            indexChoices: [],
          },
        };
      },
    };

    await expect(benchmark.createCloudReplacementAdapter(
      'qlever', engine,
    ).execute(workload, '# timed')).rejects.toThrow('selected engine');
  });

  it('rejects an empty fallback reason even when fallbackCount is zero', async () => {
    const engine: benchmark.BenchmarkSparqlEngine = {
      async queryBindings() { return (async function* () {})(); },
      getMetrics() {
        return {
          fallbackCount: 0,
          lastFallback: { reason: '' },
          lastPrimary: {
            operation: 'queryBindings',
            plan: [ 'Rdf3xPermutationScan(SPO)' ],
            indexChoices: [],
          },
        };
      },
    };

    await expect(benchmark.createCloudReplacementAdapter(
      'rdf3x', engine,
    ).execute(workload, '# timed')).rejects.toThrow('fallback');
  });

  it('fails closed on wrong engine selection or any fallback', async () => {
    const fake = (plan: string[], lastFallback?: { reason: string }) => ({
      async queryBindings() { return (async function* () {})(); },
      getMetrics() {
        return {
          fallbackCount: lastFallback === undefined ? 0 : 1,
          lastFallback,
          lastPrimary: { operation: 'queryBindings', plan, indexChoices: [] },
        };
      },
    });

    await expect(benchmark.createCloudReplacementAdapter(
      'rdf3x', fake([ 'NativeSparql' ]),
    ).execute(workload, '# timed')).rejects.toThrow('selected engine');
    await expect(benchmark.createCloudReplacementAdapter(
      'rdf3x', fake([ 'PostgresFactsQuery' ]),
    ).execute(workload, '# timed')).rejects.toThrow('selected engine');
    await expect(benchmark.createCloudReplacementAdapter(
      'rdf3x', fake([ 'Rdf3xPermutationScan(SPO)' ], { reason: 'compatibility' }),
    ).execute(workload, '# timed')).rejects.toThrow('fallback');
    await expect(benchmark.createCloudReplacementAdapter(
      'qlever', fake([ 'NativeSparql' ], { reason: '' }),
    ).execute(workload, '# timed')).rejects.toThrow('fallback');
  });

  it('returns promptly after external abort and cancels a raw operation when supported', async () => {
    let signalSeen = false;
    let rawCancelled = false;
    const engine: benchmark.BenchmarkSparqlEngine = {
      queryBindings(_query, _basePath, _scope, options) {
        signalSeen = options?.signal instanceof AbortSignal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            rawCancelled = true;
            reject(options.signal?.reason);
          }, { once: true });
        });
      },
      getMetrics() { return {}; },
    };
    const controller = new AbortController();
    const startedAt = performance.now();
    const pending = benchmark.createCloudReplacementAdapter('qlever', engine, {
      operationTimeoutMs: 1_000,
    }).execute(workload, '# timed', controller.signal);
    setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 10);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(signalSeen).toBe(true);
    expect(rawCancelled).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('applies the adapter timeout to correctness calls without an outer signal', async () => {
    let timeoutMs = 0;
    let rawCancelled = false;
    const engine: benchmark.BenchmarkSparqlEngine = {
      queryBindings(_query, _basePath, _scope, options) {
        timeoutMs = options?.timeoutMs ?? 0;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            rawCancelled = true;
            reject(options.signal?.reason);
          }, { once: true });
        });
      },
      getMetrics() { return {}; },
    };
    const startedAt = performance.now();
    const pending = benchmark.createCloudReplacementAdapter('qlever', engine, {
      operationTimeoutMs: 20,
    }).execute(workload);

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeoutMs).toBe(20);
    expect(rawCancelled).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  it('captures only work enclosed by an attributed engine phase', async () => {
    const events: string[] = [];
    const snapshots = [
      { sharedBlocksRead: 10, sharedBlocksHit: 20, tempBytes: 30, diagnosticsUnavailable: [] },
      { sharedBlocksRead: 13, sharedBlocksHit: 27, tempBytes: 41, diagnosticsUnavailable: [] },
    ];
    let snapshotIndex = 0;
    const captured = await benchmark.captureAttributedPgPhase(
      async () => {
        events.push('engine-phase');
        return 'complete';
      },
      async () => {
        events.push('snapshot');
        return snapshots[snapshotIndex++]!;
      },
    );

    expect(events).toEqual([ 'snapshot', 'engine-phase', 'snapshot' ]);
    expect(captured.result).toBe('complete');
    expect(captured.diagnostics).toMatchObject({
      sharedBlocksRead: 3,
      sharedBlocksHit: 7,
      tempBytes: 11,
    });
  });

  it('preserves an engine phase failure when the trailing diagnostics snapshot also fails', async () => {
    const primary = new Error('engine phase failed');
    const diagnosticsFailure = new Error('trailing snapshot failed');
    let snapshots = 0;

    let caught: unknown;
    try {
      await benchmark.captureAttributedPgPhase(
        async () => { throw primary; },
        async () => {
          snapshots += 1;
          if (snapshots === 2) {
            throw diagnosticsFailure;
          }
          return {
            sharedBlocksRead: 0,
            sharedBlocksHit: 0,
            tempBytes: 0,
            diagnosticsUnavailable: [],
          };
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([ primary, diagnosticsFailure ]);
  });

  it('marks reset PostgreSQL counters unavailable instead of manufacturing zero', () => {
    const delta = benchmark.calculatePgDiagnosticsDelta(
      { sharedBlocksRead: 10, sharedBlocksHit: 20, tempBytes: 30, diagnosticsUnavailable: [] },
      { sharedBlocksRead: 9, sharedBlocksHit: 25, tempBytes: 1, diagnosticsUnavailable: [] },
    );

    expect(delta.sharedBlocksRead).toBeNull();
    expect(delta.sharedBlocksHit).toBe(5);
    expect(delta.tempBytes).toBeNull();
    expect(delta.diagnosticsUnavailable).toEqual(expect.arrayContaining([
      'pg_stat_database sharedBlocksRead counter reset during phase',
      'pg_stat_database tempBytes counter reset during phase',
    ]));
  });

  it('merges PostgreSQL diagnostics with null propagation, conservative memory, and deduped unavailable reasons', () => {
    const merged = benchmark.mergeBenchmarkPgDiagnostics({
      sharedBlocksRead: 10,
      sharedBlocksHit: null,
      tempBytes: 30,
      memoryPeakBytes: 100,
      memoryLimitBytes: 500,
      diagnosticsUnavailable: [ 'hit unavailable', 'temp unavailable' ],
    }, {
      sharedBlocksRead: 2,
      sharedBlocksHit: 7,
      tempBytes: null,
      memoryPeakBytes: 150,
      memoryLimitBytes: 400,
      diagnosticsUnavailable: [ 'temp unavailable', 'memory sampled' ],
    });

    expect(merged).toEqual({
      sharedBlocksRead: 12,
      sharedBlocksHit: null,
      tempBytes: null,
      memoryPeakBytes: 150,
      memoryLimitBytes: 400,
      diagnosticsUnavailable: [ 'hit unavailable', 'temp unavailable', 'memory sampled' ],
    });

    expect(benchmark.mergeBenchmarkPgDiagnostics({
      sharedBlocksRead: null,
      sharedBlocksHit: null,
      tempBytes: null,
      memoryPeakBytes: null,
      memoryLimitBytes: null,
      diagnosticsUnavailable: [],
    }, diagnostics(1))).toMatchObject({
      sharedBlocksRead: null,
      sharedBlocksHit: null,
      tempBytes: null,
      memoryPeakBytes: null,
      memoryLimitBytes: null,
    });
  });

  it('upserts concurrency records by cache, engine, workload, and lane', () => {
    const incomplete = concurrencyRecord({
      cacheMode: 'off',
      engine: 'rdf3x',
      caseId: 'case-a',
      concurrency: 32,
      completed: 0,
      infrastructureErrors: 1,
      infrastructureFailure: true,
    });
    const complete = concurrencyRecord({
      cacheMode: 'off',
      engine: 'rdf3x',
      caseId: 'case-a',
      concurrency: 32,
      completed: 32,
      throughputPerSecond: 32,
    });
    const otherLane = concurrencyRecord({
      cacheMode: 'off',
      engine: 'rdf3x',
      caseId: 'case-a',
      concurrency: 8,
      completed: 8,
    });

    expect(benchmark.upsertBenchmarkConcurrencyRecord([
      incomplete,
      otherLane,
    ], complete)).toEqual([
      complete,
      otherLane,
    ]);
  });

  it('rebuilds aggregate diagnostics after replacing a resumed infrastructure-failed cell', () => {
    const completed = concurrencyRecord({
      cacheMode: 'off',
      engine: 'rdf3x',
      caseId: 'case-a',
      concurrency: 1,
    });
    const failedOld = concurrencyRecord({
      cacheMode: 'off',
      engine: 'rdf3x',
      caseId: 'case-b',
      concurrency: 1,
      infrastructureErrors: 1,
      infrastructureFailure: true,
    });
    const completedAfterRetry = concurrencyRecord({
      ...failedOld,
      completed: 1,
      infrastructureErrors: 0,
      infrastructureFailure: false,
    });
    const perCellDiagnostics = Object.fromEntries([
      diagnosticsByKey(completed, 10),
      diagnosticsByKey(failedOld, 20),
    ]);
    const records = benchmark.upsertBenchmarkConcurrencyRecord(
      [ completed, failedOld ],
      completedAfterRetry,
    );
    perCellDiagnostics[benchmark.benchmarkConcurrencyKey('off', 'rdf3x', 'case-b', 1)] =
      diagnostics(3);

    const aggregate = benchmark.rebuildBenchmarkDiagnosticsByCacheMode(
      records,
      perCellDiagnostics,
    );

    expect(aggregate.off?.rdf3x.sharedBlocksRead).toBe(13);
    expect(aggregate.off?.rdf3x.sharedBlocksHit).toBe(15);
  });

  it('fails closed when rebuilding aggregate diagnostics without a per-cell entry', () => {
    expect(() => benchmark.rebuildBenchmarkDiagnosticsByCacheMode([
      concurrencyRecord({
        cacheMode: 'off',
        engine: 'rdf3x',
        caseId: 'case-a',
        concurrency: 1,
      }),
    ], {})).toThrow(/Missing concurrency diagnostics/iu);
  });

  it('separates build/setup pools from cache-mode operation pools', () => {
    const pools: benchmark.BenchmarkPgPoolConfiguration[] = [];
    const createPool = (configuration: benchmark.BenchmarkPgPoolConfiguration) => {
      pools.push(configuration);
      return { benchmarkPool: pools.length };
    };
    const off = benchmark.buildBenchmarkPostgresEngineOptions(
      'rdf3x', 'postgres://example.test/xpod_benchmark', 'off', 4_321, createPool,
    );
    const production = benchmark.buildBenchmarkPostgresEngineOptions(
      'qlever', 'postgres://example.test/xpod_benchmark', 'production', 4_321, createPool,
    );
    const control = benchmark.buildBenchmarkPgPoolConfiguration(
      'postgres://example.test/xpod_benchmark',
      benchmark.BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
      4,
    );

    expect(benchmark.BENCHMARK_BUILD_SETUP_TIMEOUT_MS).toBeGreaterThan(4_321);
    expect(benchmark.BENCHMARK_QLEVER_MEMORY_LIMIT_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(benchmark.BENCHMARK_DOCKER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(control.connectionTimeoutMillis > 0).toBe(true);
    expect(control).toMatchObject({
      max: 4,
      connectionTimeoutMillis: 30_000,
      statement_timeout: benchmark.BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
      query_timeout: benchmark.BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
    });
    expect(pools).toEqual([
      expect.objectContaining({ max: 32, statement_timeout: 4_321, query_timeout: 4_321 }),
      expect.objectContaining({ max: 32, statement_timeout: 4_321, query_timeout: 4_321 }),
    ]);
    expect(off).toMatchObject({
      nativeSparqlEnabled: false,
      queryResultCacheEnabled: false,
      materializedResultCacheEnabled: false,
      pool: { benchmarkPool: 1 },
    });
    expect(production).toMatchObject({
      nativeSparqlEnabled: true,
      nativeSparqlMemoryLimitBytes: benchmark.BENCHMARK_QLEVER_MEMORY_LIMIT_BYTES,
      queryResultCacheEnabled: true,
      materializedResultCacheEnabled: true,
      pool: { benchmarkPool: 2 },
    });
    expect(benchmark.buildBenchmarkCacheModePairPlan([ 'off', 'production' ])).toEqual([
      { cacheMode: 'off', refreshDerivedIndexes: false, recordBuildAndStorage: false },
      { cacheMode: 'production', refreshDerivedIndexes: false, recordBuildAndStorage: false },
    ]);
  });

  it('uses production latency but cache-off concurrency, gates, errors, and diagnostics', () => {
    const correctness = {
      correct: true,
      sameMultiset: true,
      sameOrder: true,
      failures: [],
      rdf3x: {
        rows: [], orderedDigest: '[]', multisetDigest: '[]', fallbackReason: null,
        physicalPlan: [ 'PostgresRdf3x' ], queryElapsedMs: null,
      },
      qlever: {
        rows: [], orderedDigest: '[]', multisetDigest: '[]', fallbackReason: null,
        physicalPlan: [ 'NativeSparql' ], queryElapsedMs: null,
      },
    };
    const failedOffCorrectness = {
      ...correctness,
      correct: false,
      sameMultiset: false,
      failures: [ 'multiset-mismatch' ],
    };
    const summary = benchmark.buildBenchmarkReportSummary({
      cacheModes: [ 'off', 'production' ],
      latencyRecords: [
        { cacheMode: 'off', workload, rdf3x: latency('off', 10), qlever: latency('off', 8), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'off', workload: largeWorkload, rdf3x: latency('off', 40), qlever: latency('off', 20), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'off', workload: authorizationWorkload, rdf3x: latency('off', 10), qlever: latency('off', 5), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'production', workload, rdf3x: latency('production', 10), qlever: latency('production', 5), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'production', workload: largeWorkload, rdf3x: latency('production', 30), qlever: latency('production', 10), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'production', workload: authorizationWorkload, rdf3x: latency('production', 10), qlever: latency('production', 10), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
      ],
      concurrencyRecords: [
        concurrencyRecord({ cacheMode: 'off', engine: 'rdf3x', completed: 50, errors: 1, throughputPerSecond: 50 }),
        concurrencyRecord({ cacheMode: 'off', engine: 'qlever', completed: 75, errors: 2, throughputPerSecond: 75 }),
        concurrencyRecord({ cacheMode: 'production', engine: 'rdf3x', completed: 100, errors: 3, throughputPerSecond: 100 }),
        concurrencyRecord({ cacheMode: 'production', engine: 'qlever', completed: 200, errors: 4, throughputPerSecond: 200 }),
      ],
      correctnessRecords: [
        { cacheMode: 'off', caseId: workload.id, correctness: failedOffCorrectness },
        { cacheMode: 'off', caseId: largeWorkload.id, correctness },
        { cacheMode: 'off', caseId: authorizationWorkload.id, correctness },
        { cacheMode: 'production', caseId: workload.id, correctness },
        { cacheMode: 'production', caseId: largeWorkload.id, correctness },
        { cacheMode: 'production', caseId: authorizationWorkload.id, correctness },
      ],
      correctnessFailures: [ 'off:case-a:multiset-mismatch' ],
      diagnosticsByCacheMode: {
        off: { rdf3x: diagnostics(1), qlever: diagnostics(2) },
        production: { rdf3x: diagnostics(10), qlever: diagnostics(20) },
      },
      qleverReady: true,
    });

    expect(summary.latencyCacheMode).toBe('production');
    expect(summary.gateCacheMode).toBe('off');
    expect(summary.preferredLatency.every((record) =>
      record.cacheMode === 'production')).toBe(true);
    expect(summary.gateLatency.every((record) => record.cacheMode === 'off')).toBe(true);
    expect(summary.gateConcurrency.every((record) => record.cacheMode === 'off')).toBe(true);
    expect(summary.throughputRatio).toBe(1.5);
    expect(summary.errorRates.rdf3x).toBeCloseTo(1 / 51);
    expect(summary.errorRates.qlever).toBeCloseTo(2 / 77);
    expect(summary.infrastructureErrorRates.rdf3x).toBe(0);
    expect(summary.infrastructureErrorRates.qlever).toBe(0);
    expect(summary.evidenceComplete).toBe(true);
    expect(summary.baselineValid).toBe(false);
    expect(summary.correctnessPassed).toBe(false);
    expect(summary.decision.observed.criticalShortP95Ratios).toEqual([ 0.8 ]);
    expect(summary.decision.observed.weightedP95Ratio).toBeCloseTo(0.68);
    expect(summary.decision.observed.largeCaseSpeedups).toEqual([ 2 ]);
    expect(summary.decision.observed.errorRate).toBeCloseTo(2 / 77);
    expect(summary.resourceDiagnostics).toEqual({
      rdf3x: diagnostics(1),
      qlever: diagnostics(2),
    });
    expect(summary.qleverReady).toBe(true);
    expect(summary.environment.qleverReady).toBe(true);
    expect(summary.cases[0]?.correctness).toMatchObject({
      correct: false,
      sameMultiset: false,
      failures: [ 'off:multiset-mismatch' ],
    });
    expect(summary.cases[0]?.correctnessFailures).toEqual([ 'off:multiset-mismatch' ]);
    expect(summary.cases[0]?.qlever.p95Ms).toBe(5);
    expect(summary.cases[1]?.correctness.correct).toBe(true);

    expect(() => benchmark.buildBenchmarkReportSummary({
      ...summary.source,
      concurrencyRecords: summary.source.concurrencyRecords.map((record) =>
        record.engine === 'rdf3x' && record.cacheMode === 'off'
          ? { ...record, completed: 0 }
          : record),
    })).toThrow(/RDF3X throughput/iu);
  });

  it('separates engine error rates from infrastructure error rates', () => {
    const summary = benchmark.buildBenchmarkReportSummary({
      cacheModes: [ 'off' ],
      latencyRecords: [
        { cacheMode: 'off', workload, rdf3x: latency('off', 10), qlever: latency('off', 8), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'off', workload: largeWorkload, rdf3x: latency('off', 40), qlever: latency('off', 20), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'off', workload: authorizationWorkload, rdf3x: latency('off', 10), qlever: latency('off', 5), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
      ],
      concurrencyRecords: [
        concurrencyRecord({ cacheMode: 'off', engine: 'rdf3x', completed: 100, errors: 2 }),
        concurrencyRecord({ cacheMode: 'off', engine: 'qlever', completed: 100, errors: 2, infrastructureErrors: 50 }),
      ],
      correctnessRecords: [
        { cacheMode: 'off', caseId: workload.id, correctness: correctnessRecord(true) },
        { cacheMode: 'off', caseId: largeWorkload.id, correctness: correctnessRecord(true) },
        { cacheMode: 'off', caseId: authorizationWorkload.id, correctness: correctnessRecord(true) },
      ],
      correctnessFailures: [],
      diagnosticsByCacheMode: { off: { rdf3x: diagnostics(1), qlever: diagnostics(2) } },
      qleverReady: true,
    });

    expect(summary.errorRates.rdf3x).toBeCloseTo(2 / 102);
    expect(summary.errorRates.qlever).toBeCloseTo(2 / 102);
    expect(summary.infrastructureErrorRates.qlever).toBeCloseTo(50 / 152);
  });

  it('keeps baseline valid while incomplete infrastructure evidence blocks replacement', () => {
    const summary = benchmark.buildBenchmarkReportSummary({
      cacheModes: [ 'off' ],
      latencyRecords: [
        { cacheMode: 'off', workload, rdf3x: latency('off', 10), qlever: latency('off', 3), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'off', workload: largeWorkload, rdf3x: latency('off', 100), qlever: latency('off', 20), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
        { cacheMode: 'off', workload: authorizationWorkload, rdf3x: latency('off', 10), qlever: latency('off', 5), ignoredSteadyHelperColdMs: { rdf3x: 1, qlever: 1 } },
      ],
      concurrencyRecords: [
        concurrencyRecord({ cacheMode: 'off', engine: 'rdf3x', completed: 100, errors: 0 }),
        concurrencyRecord({
          cacheMode: 'off',
          engine: 'qlever',
          completed: 100,
          errors: 0,
          infrastructureErrors: 1,
          infrastructureFailure: true,
        }),
      ],
      correctnessRecords: [
        { cacheMode: 'off', caseId: workload.id, correctness: correctnessRecord(true) },
        { cacheMode: 'off', caseId: largeWorkload.id, correctness: correctnessRecord(true) },
        { cacheMode: 'off', caseId: authorizationWorkload.id, correctness: correctnessRecord(true) },
      ],
      correctnessFailures: [],
      diagnosticsByCacheMode: { off: { rdf3x: diagnostics(1), qlever: diagnostics(2) } },
      qleverReady: true,
    });

    expect(summary.baselineValid).toBe(true);
    expect(summary.evidenceComplete).toBe(false);
    expect(summary.correctnessPassed).toBe(false);
    expect(summary.decision.recommendation).not.toBe('replace');
  });

  it('preserves primary and cleanup failures in AggregateError', () => {
    const primary = new Error('primary');
    const cleanup = new Error('cleanup');
    let caught: unknown;
    try {
      benchmark.throwBenchmarkFailures(primary, [ cleanup ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([ primary, cleanup ]);
    expect(() => benchmark.throwBenchmarkFailures(undefined, [ cleanup ]))
      .toThrow(AggregateError);
    expect(() => benchmark.throwBenchmarkFailures(primary, [])).toThrow(primary);
    expect(benchmark.throwBenchmarkFailures(undefined, [])).toBeUndefined();
  });

  it('retries and verifies disposable local container removal', () => {
    let exists = true;
    let attempts = 0;
    benchmark.removeLocalBenchmarkContainer('benchmark-container', (args) => {
      if (args[0] === 'rm') {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient remove failure');
        }
        exists = false;
        return '';
      }
      if (args[0] === 'inspect') {
        if (exists) {
          return 'container-id';
        }
        throw new Error('No such container: benchmark-container');
      }
      throw new Error('unexpected docker command');
    });

    expect(attempts).toBe(2);
    expect(() => benchmark.removeLocalBenchmarkContainer('stuck-container', (args) => {
      if (args[0] === 'rm') {
        throw new Error('remove failed');
      }
      return 'still-present';
    })).toThrow('Failed to remove disposable benchmark container');
  });

  it('surfaces only the final sanitized Docker startup probe failure', async () => {
    let attempts = 0;
    let caught: unknown;
    try {
      await benchmark.waitForLocalPostgres('benchmark-container', {
        attempts: 2,
        delayMs: 0,
        runDocker() {
          attempts += 1;
          throw new Error(attempts === 1
            ? 'old pg_isready failure'
            : 'final psql failure password=probe-secret');
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('final psql failure');
    expect((caught as Error).message).not.toContain('old pg_isready failure');
    expect((caught as Error).message).not.toContain('probe-secret');
    expect(attempts).toBe(2);
  });

  it('adds only the manual package command and does not schedule it in workflows', () => {
    const packageJson = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'package.json'),
      'utf8',
    )) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['benchmark:rdf-cloud-replacement'])
      .toBe('bun scripts/native-rdf3x-benchmark.ts');

    for (const workflow of [ 'ci.yml', 'deploy.yml', 'release.yml' ]) {
      const workflowSource = readFileSync(
        path.join(repositoryRoot, '.github/workflows', workflow),
        'utf8',
      );
      expect(workflowSource).not.toContain('benchmark:rdf-cloud-replacement');
    }
  });
});
