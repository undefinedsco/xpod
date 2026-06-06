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
  rdfModelsBenchmarkScaleSatisfied,
  rdfModelsBenchmarkSyntheticPodCount,
  rdfModelsBenchmarkScaleTargetQuads,
  runRdfModelsPostgresBenchmark,
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
  iterations: number;
  warmupIterations: number;
  syntheticMessages: number;
  syntheticMessagesOverridden: boolean;
  syntheticPodCount: number;
  caseProfile: RdfBenchmarkCaseProfile;
  rdfAccelerationProfile: RdfPgAccelerationProfile;
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
    const report = await runRdfModelsPostgresBenchmark(engine, {
      scale: options.scale,
      iterations: options.iterations,
      warmupIterations: options.warmupIterations,
      caseProfile: options.caseProfile,
    });

    await writeJson(paths.postgresReport, {
      seed: seedSummary(options, seedQuads.length),
      report,
    });

    const fullScale = rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuads.length);
    const synced = report.storage.rdf3x?.syncedWithFacts === true;
    const accelerationMatched = rdfAccelerationProfileMatched(options.rdfAccelerationProfile, report.storage);
    const nativeExtensionPlanHits = countNativeExtensionPlanHits(report);
    const nativeExtensionPlanMatched = nativeExtensionPlanRequired(options) ? nativeExtensionPlanHits > 0 : true;
    printSummary({
      options,
      paths,
      seedQuadCount: seedQuads.length,
      targetQuadCount: rdfModelsBenchmarkScaleTargetQuads(options.scale),
      fullScale,
      synced,
      accelerationMatched,
      scanCases: report.cases.length,
      queryCases: report.queryCases.length,
      planMatched: report.planMatched,
      failedPlanCases: report.failedPlanCases,
      nativeExtensionPlanHits,
      nativeExtensionPlanMatched,
      storage: report.storage,
    });

    if (!fullScale || !synced || !report.planMatched || !accelerationMatched || !nativeExtensionPlanMatched) {
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
  let iterations = 3;
  let warmupIterations = 1;
  let syntheticMessages: number | undefined;
  let caseProfile: RdfBenchmarkCaseProfile = 'default';
  let rdfAccelerationProfile: RdfPgAccelerationProfile = 'baseline';

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
    if (arg.startsWith('--iterations=')) {
      iterations = positiveInteger(arg.slice('--iterations='.length), '--iterations');
      continue;
    }
    if (arg.startsWith('--warmupIterations=')) {
      warmupIterations = nonNegativeInteger(arg.slice('--warmupIterations='.length), '--warmupIterations');
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
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (driver === 'pg' && !connectionString) {
    throw new Error('--driver=pg requires --connectionString=...');
  }

  return {
    outDir,
    driver,
    connectionString,
    allowPgWrites,
    scale,
    iterations,
    warmupIterations,
    syntheticMessages: syntheticMessages ?? defaultSyntheticMessagesForRdfModelsScale(scale),
    syntheticMessagesOverridden: syntheticMessages !== undefined,
    syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount(scale),
    caseProfile,
    rdfAccelerationProfile,
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
  return value === 'default' || value === 'extreme' || value === 'all';
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
  if (options.driver === 'pglite') {
    return new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: paths.pgliteDataDir,
      queryResultCacheEnabled: false,
      rdfAccelerationProfile: options.rdfAccelerationProfile,
    });
  }
  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString: options.connectionString,
    queryResultCacheEnabled: false,
    rdfAccelerationProfile: options.rdfAccelerationProfile,
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
    iterations: options.iterations,
    warmupIterations: options.warmupIterations,
    syntheticMessages: options.syntheticMessages,
    syntheticMessagesOverridden: options.syntheticMessagesOverridden,
    syntheticPodCount: options.syntheticPodCount,
    caseProfile: options.caseProfile,
    rdfAccelerationProfile: options.rdfAccelerationProfile,
    seedQuadCount,
    targetQuadCount: rdfModelsBenchmarkScaleTargetQuads(options.scale),
    fullScale: rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuadCount),
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
  accelerationMatched: boolean;
  scanCases: number;
  queryCases: number;
  planMatched: boolean;
  failedPlanCases: string[];
  nativeExtensionPlanHits: number;
  nativeExtensionPlanMatched: boolean;
  storage: RdfEngineStorageStats;
}): void {
  console.log('PostgreSQL RDF models benchmark complete');
  console.log(`  driver: ${summary.options.driver}`);
  console.log(`  scale: ${summary.options.scale}`);
  console.log(`  iterations: ${summary.options.iterations}`);
  console.log(`  warmup iterations: ${summary.options.warmupIterations}`);
  console.log(`  case profile: ${summary.options.caseProfile}`);
  console.log(`  requested pg acceleration profile: ${summary.options.rdfAccelerationProfile}`);
  console.log(`  seed quads: ${summary.seedQuadCount}`);
  console.log(`  target quads: ${summary.targetQuadCount}`);
  console.log(`  full scale seed: ${summary.fullScale}`);
  console.log(`  scan cases: ${summary.scanCases}`);
  console.log(`  query cases: ${summary.queryCases}`);
  console.log(`  plan matched: ${summary.planMatched}`);
  console.log(`  rdf3x synced with facts: ${summary.synced}`);
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
    console.error('  syntheticMessages override is below the selected scale target');
  }
  if (summary.failedPlanCases.length > 0) {
    console.error(`  failed plan cases: ${summary.failedPlanCases.join(', ')}`);
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
  --iterations=N                   Iterations per case. Default: 3
  --warmupIterations=N             Warmup runs per case before timing. Default: 1
  --syntheticMessages=N            Override generated message count for storage-size tests
  --caseProfile=VALUE              default|extreme|all. Default: default
  --rdfAccelerationProfile=VALUE   baseline|pg-result-cache|pg-hot-operators|pg-custom-index. Default: baseline
  --out=PATH                       Output directory. Default: .test-data/rdf-engine
`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
