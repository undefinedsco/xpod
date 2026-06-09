import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import {
  RDF_MODELS_BENCHMARK_POD,
  PostgresRdfEngine,
  buildRdfModelsBenchmarkSeed,
  defaultSyntheticMessagesForRdfModelsScale,
  rdfModelsBenchmarkTargetSatisfied,
  rdfModelsBenchmarkSyntheticPodCount,
  rdfModelsBenchmarkScaleTargetQuads,
  rdfModelsBenchmarkProfileRequiresSearchFusion,
  runRdfModelsPostgresBenchmark,
  seedRdfModelsSearchFusionIndexes,
  syntheticMessagesForRdfModelsTargetQuads,
  type RdfBenchmarkCaseProfile,
  type RdfBenchmarkScale,
  type RdfEngineStorageStats,
  type RdfPgAccelerationProfile,
} from '../src/storage/rdf';

interface CliOptions {
  outDir: string;
  driver: 'pglite' | 'pg';
  connectionString?: string;
  allowPgWrites: boolean;
  scale: RdfBenchmarkScale;
  targetQuads: number;
  targetQuadsOverridden: boolean;
  iterations: number;
  warmupIterations: number;
  concurrency: number;
  refreshMutationSources: number;
  refreshMutationQuadsPerSource: number;
  syntheticMessages: number;
  syntheticMessagesOverridden: boolean;
  syntheticPodCount: number;
  caseProfile: RdfBenchmarkCaseProfile;
  rdfAccelerationProfile: RdfPgAccelerationProfile;
  deferPgCustomIndexBuild: boolean;
}

interface BenchmarkPaths {
  pgliteDataDir?: string;
  postgresReport: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });
  await installPgCustomIndexExtensionForBenchmark(options);

  const paths = createBenchmarkPaths(options);
  const engine = createEngine(options, paths);

  try {
    await engine.open();
    await assertWritableBenchmarkTarget(engine, options);
    const seedQuads = buildRdfModelsBenchmarkSeed(options);
    await engine.put(seedQuads);
    if (rdfModelsBenchmarkProfileRequiresSearchFusion(options.caseProfile)) {
      seedRdfModelsSearchFusionIndexes(engine);
    }
    if (options.deferPgCustomIndexBuild) {
      await engine.ensurePgCustomIndexes();
    }
    const report = await runRdfModelsPostgresBenchmark(engine, {
      scale: options.scale,
      iterations: options.iterations,
      warmupIterations: options.warmupIterations,
      concurrency: options.concurrency,
      refreshMutationSources: options.refreshMutationSources,
      refreshMutationQuadsPerSource: options.refreshMutationQuadsPerSource,
      caseProfile: options.caseProfile,
    });

    await writeJson(paths.postgresReport, {
      seed: seedSummary(options, seedQuads.length),
      report,
    });

    const fullScale = rdfModelsBenchmarkTargetSatisfied(options.targetQuads, seedQuads.length);
    const synced = report.storage.rdf3x?.syncedWithFacts === true;
    const plannerStatsTables = postgresPlannerStatsTables(report);
    const plannerStatsMatched = plannerStatsTables.length > 0;
    const accelerationMatched = rdfAccelerationProfileMatched(options.rdfAccelerationProfile, report.storage);
    const nativeExtensionPlanHits = countNativeExtensionPlanHits(report);
    const nativeExtensionPlanMatched = nativeExtensionPlanRequired(options) ? nativeExtensionPlanHits > 0 : true;
    const concurrencyMatched = report.concurrencyGate.matched;
    const postWriteRefreshMatched = options.refreshMutationSources === 0
      || report.postWriteRefreshBenchmark?.matched === true;
    printSummary({
      options,
      paths,
      seedQuadCount: seedQuads.length,
      targetQuadCount: options.targetQuads,
      fullScale,
      synced,
      plannerStatsMatched,
      plannerStatsTables,
      refreshBenchmark: report.refreshBenchmark,
      postWriteRefreshBenchmark: report.postWriteRefreshBenchmark,
      coldStartBenchmark: report.coldStartBenchmark,
      accelerationMatched,
      scanCases: report.cases.length,
      queryCases: report.queryCases.length,
      planMatched: report.planMatched,
      failedPlanCases: report.failedPlanCases,
      concurrencyMatched,
      failedConcurrencyCases: report.concurrencyGate.failedCases,
      postWriteRefreshMatched,
      nativeExtensionPlanHits,
      nativeExtensionPlanMatched,
      storage: report.storage,
    });

    if (!fullScale || !synced || !plannerStatsMatched || !report.planMatched || !accelerationMatched || !nativeExtensionPlanMatched || !concurrencyMatched || !postWriteRefreshMatched) {
      process.exitCode = 1;
    }
  } finally {
    await engine.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  let outDir = path.join(process.cwd(), '.test-data', 'rdf-engine');
  let driver: CliOptions['driver'] = 'pglite';
  let connectionString: string | undefined;
  let allowPgWrites = false;
  let scale: RdfBenchmarkScale = 'medium';
  let targetQuads: number | undefined;
  let iterations = 3;
  let warmupIterations = 1;
  let concurrency = 1;
  let refreshMutationSources = 0;
  let refreshMutationQuadsPerSource = 6;
  let syntheticMessages: number | undefined;
  let caseProfile: RdfBenchmarkCaseProfile = 'default';
  let rdfAccelerationProfile: RdfPgAccelerationProfile = 'baseline';
  let deferPgCustomIndexBuild: boolean | undefined;

  for (const arg of args) {
    if (arg.startsWith('--out=')) {
      outDir = path.resolve(arg.slice('--out='.length));
      continue;
    }
    if (arg.startsWith('--driver=')) {
      const value = arg.slice('--driver='.length);
      if (value !== 'pglite' && value !== 'pg') {
        throw new Error(`Unsupported --driver value: ${value}`);
      }
      driver = value;
      continue;
    }
    if (arg.startsWith('--connectionString=')) {
      connectionString = arg.slice('--connectionString='.length);
      continue;
    }
    if (arg === '--allowPgWrites') {
      allowPgWrites = true;
      continue;
    }
    if (arg.startsWith('--scale=')) {
      const value = arg.slice('--scale='.length);
      if (value !== 'small' && value !== 'medium' && value !== 'large') {
        throw new Error(`Unsupported --scale value: ${value}`);
      }
      scale = value;
      continue;
    }
    if (arg.startsWith('--targetQuads=')) {
      targetQuads = positiveInteger(arg.slice('--targetQuads='.length), '--targetQuads');
      continue;
    }
    if (arg.startsWith('--iterations=')) {
      iterations = positiveInteger(arg.slice('--iterations='.length), '--iterations');
      continue;
    }
    if (arg.startsWith('--warmupIterations=')) {
      warmupIterations = nonNegativeInteger(arg.slice('--warmupIterations='.length), '--warmupIterations');
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      concurrency = positiveInteger(arg.slice('--concurrency='.length), '--concurrency');
      continue;
    }
    if (arg.startsWith('--refreshMutationSources=')) {
      refreshMutationSources = nonNegativeInteger(arg.slice('--refreshMutationSources='.length), '--refreshMutationSources');
      continue;
    }
    if (arg.startsWith('--refreshMutationQuadsPerSource=')) {
      refreshMutationQuadsPerSource = positiveInteger(arg.slice('--refreshMutationQuadsPerSource='.length), '--refreshMutationQuadsPerSource');
      continue;
    }
    if (arg.startsWith('--syntheticMessages=')) {
      syntheticMessages = positiveInteger(arg.slice('--syntheticMessages='.length), '--syntheticMessages');
      continue;
    }
    if (arg.startsWith('--caseProfile=')) {
      const value = arg.slice('--caseProfile='.length);
      if (!isRdfBenchmarkCaseProfile(value)) {
        throw new Error(`Unsupported --caseProfile value: ${value}`);
      }
      caseProfile = value;
      continue;
    }
    if (arg.startsWith('--rdfAccelerationProfile=')) {
      const value = arg.slice('--rdfAccelerationProfile='.length);
      if (!isRdfPgAccelerationProfile(value)) {
        throw new Error(`Unsupported --rdfAccelerationProfile value: ${value}`);
      }
      rdfAccelerationProfile = value;
      continue;
    }
    if (arg === '--deferPgCustomIndexBuild') {
      deferPgCustomIndexBuild = true;
      continue;
    }
    if (arg === '--noDeferPgCustomIndexBuild') {
      deferPgCustomIndexBuild = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (driver === 'pg' && !connectionString) {
    throw new Error('--driver=pg requires --connectionString=...');
  }

  const resolvedTargetQuads = targetQuads ?? rdfModelsBenchmarkScaleTargetQuads(scale);
  return {
    outDir,
    driver,
    connectionString,
    allowPgWrites,
    scale,
    targetQuads: resolvedTargetQuads,
    targetQuadsOverridden: targetQuads !== undefined,
    iterations,
    warmupIterations,
    concurrency,
    refreshMutationSources,
    refreshMutationQuadsPerSource,
    syntheticMessages: syntheticMessages ?? (
      targetQuads !== undefined
        ? syntheticMessagesForRdfModelsTargetQuads(resolvedTargetQuads)
        : defaultSyntheticMessagesForRdfModelsScale(scale)
    ),
    syntheticMessagesOverridden: syntheticMessages !== undefined,
    syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount(scale),
    caseProfile,
    rdfAccelerationProfile,
    deferPgCustomIndexBuild: deferPgCustomIndexBuild ?? (driver === 'pg' && rdfAccelerationProfile === 'pg-custom-index'),
  };
}

function positiveInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function isRdfPgAccelerationProfile(value: string): value is RdfPgAccelerationProfile {
  return value === 'baseline'
    || value === 'pg-result-cache'
    || value === 'pg-hot-operators'
    || value === 'pg-custom-index';
}

function isRdfBenchmarkCaseProfile(value: string): value is RdfBenchmarkCaseProfile {
  return value === 'default' || value === 'extreme' || value === 'fusion' || value === 'all';
}

function rdfAccelerationProfileMatched(profile: RdfPgAccelerationProfile, storage: RdfEngineStorageStats): boolean {
  const stats = storage.pgAcceleration;
  if (profile === 'baseline') {
    return stats?.profile === 'baseline' && stats.enabled === false;
  }
  if (profile === 'pg-custom-index') {
    return stats?.profile === profile
      && stats.enabled === true
      && stats.capabilityProviders?.['index.xpod_rdf_perm'] === 'extension';
  }
  return stats?.profile === profile && stats.enabled === true;
}

function nativeExtensionPlanRequired(options: CliOptions): boolean {
  return options.rdfAccelerationProfile === 'pg-custom-index'
    && (options.caseProfile === 'extreme' || options.caseProfile === 'all');
}

function countNativeExtensionPlanHits(report: Awaited<ReturnType<typeof runRdfModelsPostgresBenchmark>>): number {
  return [
    ...report.cases.flatMap((testCase) => testCase.physicalPlan),
    ...report.queryCases.flatMap((testCase) => testCase.physicalPlan),
  ].filter((entry) => entry.includes('XpodRdfExtensionOperator(')).length;
}

function postgresPlannerStatsTables(report: Awaited<ReturnType<typeof runRdfModelsPostgresBenchmark>>): string[] {
  const rdf3x = report.refresh?.rdf3x;
  if (rdf3x?.syncedWithFacts !== true) {
    return [];
  }
  return rdf3x.plannerStats?.analyzedTables ?? [];
}

function createBenchmarkPaths(options: CliOptions): BenchmarkPaths {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${stamp}-${process.pid}-${randomUUID()}`;
  return {
    ...(options.driver === 'pglite'
      ? { pgliteDataDir: path.join(options.outDir, `rdf-models-pglite-${runId}`) }
      : {}),
    postgresReport: path.join(options.outDir, `models-postgres-${runId}.json`),
  };
}

function createEngine(options: CliOptions, paths: BenchmarkPaths): PostgresRdfEngine {
  const searchIndexes = rdfModelsBenchmarkProfileRequiresSearchFusion(options.caseProfile)
    ? {
        textIndex: { path: ':memory:' },
        vectorIndex: { path: ':memory:' },
      }
    : {};
  if (options.driver === 'pglite') {
    return new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: paths.pgliteDataDir,
      queryResultCacheEnabled: false,
      rdfAccelerationProfile: options.rdfAccelerationProfile,
      deferPgCustomIndexInitialization: options.deferPgCustomIndexBuild,
      ...searchIndexes,
    });
  }
  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString: options.connectionString,
    queryResultCacheEnabled: false,
    rdfAccelerationProfile: options.rdfAccelerationProfile,
    deferPgCustomIndexInitialization: options.deferPgCustomIndexBuild,
    ...searchIndexes,
  });
}

async function installPgCustomIndexExtensionForBenchmark(options: CliOptions): Promise<void> {
  if (options.driver !== 'pg' || options.rdfAccelerationProfile !== 'pg-custom-index') {
    return;
  }
  if (!options.allowPgWrites) {
    throw new Error('--rdfAccelerationProfile=pg-custom-index on --driver=pg installs xpod_rdf; pass --allowPgWrites only for a disposable empty PostgreSQL database');
  }
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS xpod_rdf');
  } catch (error) {
    throw new Error(`Failed to install xpod_rdf extension for pg-custom-index benchmark: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.end();
  }
}

async function assertWritableBenchmarkTarget(engine: PostgresRdfEngine, options: CliOptions): Promise<void> {
  if (options.driver !== 'pg') {
    return;
  }
  if (!options.allowPgWrites) {
    throw new Error('--driver=pg writes RDF benchmark rows; pass --allowPgWrites only for a disposable empty PostgreSQL database');
  }
  const stats = await engine.storageStats();
  if (stats.facts.quadCount > 0 || stats.facts.sourceCount > 0) {
    throw new Error(`PostgreSQL benchmark target is not empty: ${stats.facts.quadCount} quads, ${stats.facts.sourceCount} sources`);
  }
}

function seedSummary(options: CliOptions, seedQuadCount: number): Record<string, unknown> {
  return {
    pod: RDF_MODELS_BENCHMARK_POD,
    driver: options.driver,
    scale: options.scale,
    targetQuads: options.targetQuads,
    targetQuadsOverridden: options.targetQuadsOverridden,
    iterations: options.iterations,
    warmupIterations: options.warmupIterations,
    concurrency: options.concurrency,
    refreshMutationSources: options.refreshMutationSources,
    refreshMutationQuadsPerSource: options.refreshMutationQuadsPerSource,
    syntheticMessages: options.syntheticMessages,
    syntheticMessagesOverridden: options.syntheticMessagesOverridden,
    syntheticPodCount: options.syntheticPodCount,
    caseProfile: options.caseProfile,
    rdfAccelerationProfile: options.rdfAccelerationProfile,
    deferPgCustomIndexBuild: options.deferPgCustomIndexBuild,
    seedQuadCount,
    targetQuadCount: options.targetQuads,
    fullScale: rdfModelsBenchmarkTargetSatisfied(options.targetQuads, seedQuadCount),
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function printSummary(summary: {
  options: CliOptions;
  paths: BenchmarkPaths;
  seedQuadCount: number;
  targetQuadCount: number;
  fullScale: boolean;
  synced: boolean;
  plannerStatsMatched: boolean;
  plannerStatsTables: string[];
  refreshBenchmark?: Awaited<ReturnType<typeof runRdfModelsPostgresBenchmark>>['refreshBenchmark'];
  postWriteRefreshBenchmark?: Awaited<ReturnType<typeof runRdfModelsPostgresBenchmark>>['postWriteRefreshBenchmark'];
  coldStartBenchmark?: Awaited<ReturnType<typeof runRdfModelsPostgresBenchmark>>['coldStartBenchmark'];
  accelerationMatched: boolean;
  scanCases: number;
  queryCases: number;
  planMatched: boolean;
  failedPlanCases: string[];
  concurrencyMatched: boolean;
  failedConcurrencyCases: string[];
  postWriteRefreshMatched: boolean;
  nativeExtensionPlanHits: number;
  nativeExtensionPlanMatched: boolean;
  storage: RdfEngineStorageStats;
}): void {
  console.log('PostgreSQL RDF models benchmark complete');
  console.log(`  driver: ${summary.options.driver}`);
  console.log(`  scale: ${summary.options.scale}`);
  console.log(`  target quads overridden: ${summary.options.targetQuadsOverridden}`);
  console.log(`  iterations: ${summary.options.iterations}`);
  console.log(`  warmup iterations: ${summary.options.warmupIterations}`);
  console.log(`  concurrency: ${summary.options.concurrency}`);
  console.log(`  case profile: ${summary.options.caseProfile}`);
  console.log(`  requested pg acceleration profile: ${summary.options.rdfAccelerationProfile}`);
  console.log(`  defer pg custom index build: ${summary.options.deferPgCustomIndexBuild}`);
  console.log(`  seed quads: ${summary.seedQuadCount}`);
  console.log(`  target quads: ${summary.targetQuadCount}`);
  console.log(`  full scale seed: ${summary.fullScale}`);
  console.log(`  scan cases: ${summary.scanCases}`);
  console.log(`  query cases: ${summary.queryCases}`);
  console.log(`  plan matched: ${summary.planMatched}`);
  console.log(`  concurrency gate matched: ${summary.concurrencyMatched}`);
  console.log(`  post-write refresh gate matched: ${summary.postWriteRefreshMatched}`);
  console.log(`  rdf3x synced with facts: ${summary.synced}`);
  console.log(`  planner stats refreshed: ${summary.plannerStatsMatched}`);
  console.log(`  planner stats tables: ${summary.plannerStatsTables.join(', ') || 'none'}`);
  if (summary.refreshBenchmark) {
    console.log(`  refresh duration ms: ${summary.refreshBenchmark.durationMs}`);
    console.log(`  refresh rebuild mode: ${summary.refreshBenchmark.rebuildMode ?? 'none'}`);
    console.log(`  refresh source queue: ${summary.refreshBenchmark.sourceQueue?.drainedSources ?? 0}/${summary.refreshBenchmark.sourceQueue?.pendingSources ?? 0}`);
  }
  if (summary.postWriteRefreshBenchmark) {
    console.log(`  post-write refresh mutation sources: ${summary.postWriteRefreshBenchmark.mutationSources}`);
    console.log(`  post-write refresh mutation quads: ${summary.postWriteRefreshBenchmark.mutationQuads}`);
    console.log(`  post-write pending sources before refresh: ${summary.postWriteRefreshBenchmark.pendingSourcesBeforeRefresh}`);
    console.log(`  post-write refresh duration ms: ${summary.postWriteRefreshBenchmark.durationMs}`);
    console.log(`  post-write refresh rebuild mode: ${summary.postWriteRefreshBenchmark.rebuildMode ?? 'none'}`);
    console.log(`  post-write refresh source queue: ${summary.postWriteRefreshBenchmark.sourceQueue?.drainedSources ?? 0}/${summary.postWriteRefreshBenchmark.sourceQueue?.pendingSources ?? 0}`);
    console.log(`  post-write refresh gate failed reasons: ${summary.postWriteRefreshBenchmark.failedReasons.join(', ') || 'none'}`);
  }
  if (summary.coldStartBenchmark) {
    console.log(`  cold start open duration ms: ${summary.coldStartBenchmark.startup?.durationMs ?? 'unknown'}`);
    console.log(`  cold start phase count: ${summary.coldStartBenchmark.startup?.phases.length ?? 0}`);
    console.log(`  first query after refresh: ${summary.coldStartBenchmark.firstQueryAfterRefresh?.queryCase ?? 'none'}`);
    console.log(`  first query after refresh duration ms: ${summary.coldStartBenchmark.firstQueryAfterRefresh?.durationMs ?? 'unknown'}`);
    console.log(`  warm steady query p50/p95 ms: ${summary.coldStartBenchmark.warmSteadyState ? `${summary.coldStartBenchmark.warmSteadyState.p50DurationMs}/${summary.coldStartBenchmark.warmSteadyState.p95DurationMs}` : 'unknown'}`);
  }
  console.log(`  pg acceleration profile: ${summary.storage.pgAcceleration?.profile ?? 'unknown'}`);
  console.log(`  pg acceleration enabled: ${summary.storage.pgAcceleration?.enabled ?? false}`);
  console.log(`  pg acceleration matched request: ${summary.accelerationMatched}`);
  console.log(`  pg acceleration fallback: ${summary.storage.pgAcceleration?.fallbackReason ?? 'none'}`);
  console.log(`  pg missing capabilities: ${(summary.storage.pgAcceleration?.missingCapabilities ?? []).join(', ') || 'none'}`);
  console.log(`  pg active operators: ${(summary.storage.pgAcceleration?.activeOperators ?? []).join(', ') || 'none'}`);
  console.log(`  native extension plan hits: ${summary.nativeExtensionPlanHits}`);
  console.log(`  storage facts bytes: ${summary.storage.factsBytes}`);
  console.log(`  storage derived bytes: ${summary.storage.derivedBytes}`);
  console.log(`  storage total/facts ratio: ${formatRatio(summary.storage.totalToFactsRatio)}`);
  if (summary.paths.pgliteDataDir) {
    console.log(`  pglite data dir: ${summary.paths.pgliteDataDir}`);
  }
  console.log(`  postgres report: ${summary.paths.postgresReport}`);
  if (summary.options.syntheticMessagesOverridden && !summary.fullScale) {
    console.error('  syntheticMessages override is below the selected target quads');
  }
  if (summary.failedPlanCases.length > 0) {
    console.error(`  failed plan cases: ${summary.failedPlanCases.join(', ')}`);
  }
  if (summary.failedConcurrencyCases.length > 0) {
    console.error(`  failed concurrency cases: ${summary.failedConcurrencyCases.join(', ')}`);
  }
  if (!summary.postWriteRefreshMatched) {
    console.error(`  post-write refresh gate failed: ${summary.postWriteRefreshBenchmark?.failedReasons.join(', ') || 'missing benchmark result'}`);
  }
  if (!summary.plannerStatsMatched) {
    console.error('  refreshDerivedIndexes did not report planner stats refresh');
  }
  if (!summary.accelerationMatched) {
    console.error('  requested pg acceleration profile was not enabled');
  }
  if (!summary.nativeExtensionPlanMatched) {
    console.error('  pg-custom-index extreme/all benchmark did not hit any native extension operator');
  }
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'Infinity';
}

function printHelp(): void {
  console.log(`Usage: bun scripts/rdf-postgres-models-benchmark.ts [options]

Options:
  --driver=pglite|pg                Select PostgreSQL driver. Default: pglite
  --connectionString=URL            PostgreSQL URL for --driver=pg
  --allowPgWrites                   Required for --driver=pg; only use with a disposable empty database
  --scale=small|medium|large       Select benchmark case scale. Default: medium
  --targetQuads=N                  Override seed/full-scale gate target and default synthetic message count
  --iterations=N                   Iterations per case. Default: 3
  --warmupIterations=N             Warmup runs per case before timing. Default: 1
  --concurrency=N                  Concurrent query lanes for consistency gate. Default: 1
  --refreshMutationSources=N       Write N dirty sources after seed refresh, then time incremental refresh. Default: 0
  --refreshMutationQuadsPerSource=N Quads per mutation source when refreshMutationSources is enabled. Default: 6
  --syntheticMessages=N            Override generated message count for storage-size tests
  --caseProfile=VALUE              default|extreme|fusion|all. Default: default
                                   fusion seeds in-process text/vector indexes for PG facts join
  --rdfAccelerationProfile=VALUE   baseline|pg-result-cache|pg-hot-operators|pg-custom-index. Default: baseline
  --deferPgCustomIndexBuild        Build pg-custom-index indexes after seeding. Default for --driver=pg + pg-custom-index
  --noDeferPgCustomIndexBuild      Keep old eager custom-index build behavior
  --out=PATH                       Output directory. Default: .test-data/rdf-engine
`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
