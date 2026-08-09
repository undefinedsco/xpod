import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RDF_MODELS_BENCHMARK_POD,
  PostgresRdfEngine,
  buildRdfModelsBenchmarkSeed,
  defaultSyntheticMessagesForRdfModelsScale,
  rdfModelsBenchmarkTargetSatisfied,
  rdfModelsBenchmarkSyntheticPodCount,
  rdfModelsBenchmarkScaleTargetQuads,
  rdfModelsSearchFusionBroadSourceCountForScale,
  rdfModelsBenchmarkProfileRequiresSearchFusion,
  runRdfModelsPostgresBenchmark,
  seedRdfModelsSearchFusionIndexes,
  syntheticMessagesForRdfModelsTargetQuads,
  type RdfBenchmarkCaseProfile,
  type RdfBenchmarkScale,
  type PostgresRdfEngineOptions,
  type RdfEngineStorageStats,
  type RdfModelPostgresBenchmarkGateBaseline,
  type RdfModelPostgresBenchmarkGateCaseThresholds,
  type RdfModelPostgresBenchmarkGateThresholds,
  type RdfPgAccelerationProfile,
  type PostgresRdfTextSearchBackend,
} from '../src/storage/rdf';

interface BenchmarkGateConfigSource {
  kind: 'config' | 'report-config' | 'baseline-report';
  path: string;
  calibratedLimits?: boolean;
  seed?: BenchmarkGateReportShape;
}

interface BenchmarkGateReportShape {
  driver?: 'pglite' | 'pg';
  scale?: RdfBenchmarkScale;
  targetQuads?: number;
  caseProfile?: RdfBenchmarkCaseProfile;
  rdfAccelerationProfile?: RdfPgAccelerationProfile;
  textSearchBackend?: PostgresRdfTextSearchBackend;
}

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
  searchFusionBroadSourceCount: number;
  caseProfile: RdfBenchmarkCaseProfile;
  rdfAccelerationProfile: RdfPgAccelerationProfile;
  textSearchBackend: PostgresRdfTextSearchBackend;
  servingRegressionThresholds?: RdfModelPostgresBenchmarkGateThresholds;
  fusionBenchmarkThresholds?: RdfModelPostgresBenchmarkGateThresholds;
  fusionBenchmarkBaselines?: Record<string, RdfModelPostgresBenchmarkGateBaseline>;
  benchmarkGateConfigSources?: BenchmarkGateConfigSource[];
}

interface BenchmarkPaths {
  pgliteDataDir?: string;
  postgresReport: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });

  const paths = createBenchmarkPaths(options);
  const engine = createEngine(options, paths);

  try {
    await engine.open();
    await assertWritableBenchmarkTarget(engine, options);
    const seedQuads = buildRdfModelsBenchmarkSeed({
      ...options,
      searchFusionBroadSourceCount: options.searchFusionBroadSourceCount,
    });
    const seedStartedAt = Date.now();
    await engine.put(seedQuads);
    const seedIngestDurationMs = Date.now() - seedStartedAt;
    const seedStorage = await engine.storageStats();
    if (rdfModelsBenchmarkProfileRequiresSearchFusion(options.caseProfile)) {
      await seedRdfModelsSearchFusionIndexes(engine, {
        broadSourceCount: options.searchFusionBroadSourceCount,
      });
    }
    const report = await runRdfModelsPostgresBenchmark(engine, {
      scale: options.scale,
      iterations: options.iterations,
      warmupIterations: options.warmupIterations,
      concurrency: options.concurrency,
      refreshMutationSources: options.refreshMutationSources,
      refreshMutationQuadsPerSource: options.refreshMutationQuadsPerSource,
      caseProfile: options.caseProfile,
      servingRegressionThresholds: options.servingRegressionThresholds,
      fusionBenchmarkThresholds: options.fusionBenchmarkThresholds,
      fusionBenchmarkBaselines: options.fusionBenchmarkBaselines,
    });

    await writeJson(paths.postgresReport, {
      seed: seedSummary(options, seedQuads.length, seedIngestDurationMs, seedStorage),
      report,
    });

    const fullScale = rdfModelsBenchmarkTargetSatisfied(options.targetQuads, seedQuads.length);
    const synced = report.storage.rdf3x?.syncedWithFacts === true;
    const plannerStatsTables = postgresPlannerStatsTables(report);
    const plannerStatsMatched = plannerStatsTables.length > 0;
    const accelerationMatched = rdfAccelerationProfileMatched(options.rdfAccelerationProfile, report.storage);
    const concurrencyMatched = report.concurrencyGate.matched;
    const postWriteRefreshMatched = options.refreshMutationSources === 0
      || report.postWriteRefreshBenchmark?.matched === true;
    printSummary({
      options,
      paths,
      seedQuadCount: seedQuads.length,
      targetQuadCount: options.targetQuads,
      seedIngestDurationMs,
      seedBulkLoad: seedStorage.bulkLoad,
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
      storage: report.storage,
    });

    if (!fullScale || !synced || !plannerStatsMatched || !report.planMatched || !accelerationMatched || !concurrencyMatched || !postWriteRefreshMatched) {
      process.exitCode = 1;
    }
  } finally {
    await engine.close();
  }
}

export function parseArgs(args: string[]): CliOptions {
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
  let textSearchBackend: PostgresRdfTextSearchBackend = 'posting';
  let servingRegressionThresholds: RdfModelPostgresBenchmarkGateThresholds | undefined;
  let fusionBenchmarkThresholds: RdfModelPostgresBenchmarkGateThresholds | undefined;
  let fusionBenchmarkBaselines: Record<string, RdfModelPostgresBenchmarkGateBaseline> | undefined;
  const benchmarkGateConfigSources: BenchmarkGateConfigSource[] = [];

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
    if (arg.startsWith('--textSearchBackend=')) {
      const value = arg.slice('--textSearchBackend='.length);
      if (!isPostgresRdfTextSearchBackend(value)) {
        throw new Error(`Unsupported --textSearchBackend value: ${value}`);
      }
      textSearchBackend = value;
      continue;
    }
    if (arg.startsWith('--benchmarkGateConfig=')) {
      const configPath = path.resolve(arg.slice('--benchmarkGateConfig='.length));
      const config = readBenchmarkGateConfig(configPath);
      servingRegressionThresholds = config.servingRegressionThresholds;
      fusionBenchmarkThresholds = config.fusionBenchmarkThresholds;
      fusionBenchmarkBaselines = config.fusionBenchmarkBaselines;
      benchmarkGateConfigSources.push({ kind: 'config', path: configPath });
      continue;
    }
    if (arg.startsWith('--benchmarkGateConfigFromReport=')) {
      const configPath = path.resolve(arg.slice('--benchmarkGateConfigFromReport='.length));
      const config = readBenchmarkGateConfigFromReport(configPath);
      servingRegressionThresholds = config.servingRegressionThresholds;
      fusionBenchmarkThresholds = config.fusionBenchmarkThresholds;
      fusionBenchmarkBaselines = config.fusionBenchmarkBaselines;
      benchmarkGateConfigSources.push({
        kind: 'report-config',
        path: configPath,
        calibratedLimits: true,
        ...(config.seed ? { seed: config.seed } : {}),
      });
      continue;
    }
    if (arg.startsWith('--benchmarkGateBaselineReport=')) {
      const configPath = path.resolve(arg.slice('--benchmarkGateBaselineReport='.length));
      fusionBenchmarkBaselines = readBenchmarkGateBaselineReport(configPath);
      const seed = readBenchmarkGateReportShape(configPath);
      benchmarkGateConfigSources.push({
        kind: 'baseline-report',
        path: configPath,
        ...(seed ? { seed } : {}),
      });
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
  const searchFusionBroadSourceCount = rdfModelsSearchFusionBroadSourceCountForScale(scale);
  validateBenchmarkGateConfigSources({
    driver,
    scale,
    targetQuads: resolvedTargetQuads,
    caseProfile,
    textSearchBackend,
    sources: benchmarkGateConfigSources,
  });
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
    searchFusionBroadSourceCount,
    caseProfile,
    rdfAccelerationProfile,
    textSearchBackend,
    ...(servingRegressionThresholds ? { servingRegressionThresholds } : {}),
    ...(fusionBenchmarkThresholds ? { fusionBenchmarkThresholds } : {}),
    ...(fusionBenchmarkBaselines ? { fusionBenchmarkBaselines } : {}),
    ...(benchmarkGateConfigSources.length > 0 ? { benchmarkGateConfigSources } : {}),
  };
}

function readBenchmarkGateConfig(filePath: string): {
  servingRegressionThresholds?: RdfModelPostgresBenchmarkGateThresholds;
  fusionBenchmarkThresholds?: RdfModelPostgresBenchmarkGateThresholds;
  fusionBenchmarkBaselines?: Record<string, RdfModelPostgresBenchmarkGateBaseline>;
} {
  const parsed = JSON.parse(readFileSync(path.resolve(filePath), 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('--benchmarkGateConfig must point to a JSON object');
  }
  return {
    ...(parsed.servingRegressionThresholds !== undefined ? {
      servingRegressionThresholds: benchmarkGateThresholds(parsed.servingRegressionThresholds, 'servingRegressionThresholds'),
    } : {}),
    ...(parsed.fusionBenchmarkThresholds !== undefined ? {
      fusionBenchmarkThresholds: benchmarkGateThresholds(parsed.fusionBenchmarkThresholds, 'fusionBenchmarkThresholds'),
    } : {}),
    ...(parsed.fusionBenchmarkBaselines !== undefined ? {
      fusionBenchmarkBaselines: benchmarkGateBaselines(parsed.fusionBenchmarkBaselines),
    } : {}),
  };
}

function readBenchmarkGateConfigFromReport(filePath: string): {
  servingRegressionThresholds?: RdfModelPostgresBenchmarkGateThresholds;
  fusionBenchmarkThresholds?: RdfModelPostgresBenchmarkGateThresholds;
  fusionBenchmarkBaselines?: Record<string, RdfModelPostgresBenchmarkGateBaseline>;
  seed?: BenchmarkGateReportShape;
} {
  const resolvedPath = path.resolve(filePath);
  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('--benchmarkGateConfigFromReport must point to a JSON object');
  }
  const report = isRecord(parsed.report) ? parsed.report : parsed;
  if (!isRecord(report)) {
    throw new Error('--benchmarkGateConfigFromReport must contain a report object');
  }
  if (!Array.isArray(report.queryCases)) {
    throw new Error('--benchmarkGateConfigFromReport report.queryCases must be an array');
  }
  return {
    servingRegressionThresholds: benchmarkGateThresholdsFromReportCases(report, 'servingRegressionGate'),
    fusionBenchmarkThresholds: benchmarkGateThresholdsFromReportCases(report, 'fusionBenchmarkGate'),
    fusionBenchmarkBaselines: readBenchmarkGateBaselineReport(resolvedPath, { calibratedLimits: true }),
    seed: benchmarkGateReportShape(parsed),
  };
}

function readBenchmarkGateReportShape(filePath: string): BenchmarkGateReportShape | undefined {
  const parsed = JSON.parse(readFileSync(path.resolve(filePath), 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    return undefined;
  }
  return benchmarkGateReportShape(parsed);
}

function benchmarkGateThresholdsFromReportCases(
  report: Record<string, unknown>,
  gateName: 'servingRegressionGate' | 'fusionBenchmarkGate',
): RdfModelPostgresBenchmarkGateThresholds | undefined {
  const caseNames = benchmarkGateCaseNamesFromReport(report, gateName);
  if (caseNames.size === 0) {
    return undefined;
  }
  const cases: Record<string, RdfModelPostgresBenchmarkGateCaseThresholds> = {};
  for (const rawCase of report.queryCases as unknown[]) {
    if (!isRecord(rawCase) || typeof rawCase.name !== 'string' || !caseNames.has(rawCase.name)) {
      continue;
    }
    cases[rawCase.name] = {
      maxScannedRows: calibratedScannedRowsThreshold(rawCase.scannedRows, `queryCases.${rawCase.name}.scannedRows`),
      maxP95DurationMs: calibratedP95DurationThreshold(rawCase.p95DurationMs, `queryCases.${rawCase.name}.p95DurationMs`),
      maxDurationMs: calibratedMaxDurationThreshold(
        maxDurationFromReportCase(rawCase),
        `queryCases.${rawCase.name}.durationsMs`,
      ),
    };
  }
  return Object.keys(cases).length > 0 ? { cases } : undefined;
}

function benchmarkGateReportShape(parsed: Record<string, unknown>): BenchmarkGateReportShape | undefined {
  const seed = isRecord(parsed.seed) ? parsed.seed : undefined;
  if (!seed) {
    return undefined;
  }
  const shape: BenchmarkGateReportShape = {
    ...(seed.driver === 'pglite' || seed.driver === 'pg' ? { driver: seed.driver } : {}),
    ...(seed.scale === 'small' || seed.scale === 'medium' || seed.scale === 'large' ? { scale: seed.scale } : {}),
    ...(typeof seed.targetQuads === 'number' && Number.isFinite(seed.targetQuads) ? { targetQuads: seed.targetQuads } : {}),
    ...(typeof seed.caseProfile === 'string' && isRdfBenchmarkCaseProfile(seed.caseProfile) ? { caseProfile: seed.caseProfile } : {}),
    ...(typeof seed.rdfAccelerationProfile === 'string' && isRdfPgAccelerationProfile(seed.rdfAccelerationProfile) ? {
      rdfAccelerationProfile: seed.rdfAccelerationProfile,
    } : {}),
    ...(typeof seed.textSearchBackend === 'string' && isPostgresRdfTextSearchBackend(seed.textSearchBackend) ? {
      textSearchBackend: seed.textSearchBackend,
    } : {}),
  };
  return Object.keys(shape).length > 0 ? shape : undefined;
}

function validateBenchmarkGateConfigSources(input: {
  driver: 'pglite' | 'pg';
  scale: RdfBenchmarkScale;
  targetQuads: number;
  caseProfile: RdfBenchmarkCaseProfile;
  textSearchBackend: PostgresRdfTextSearchBackend;
  sources: readonly BenchmarkGateConfigSource[];
}): void {
  for (const source of input.sources) {
    if ((source.kind !== 'report-config' && source.kind !== 'baseline-report') || !source.seed) {
      continue;
    }
    const mismatches: string[] = [];
    if (source.seed.driver && source.seed.driver !== input.driver) {
      mismatches.push(`driver expected ${input.driver}, got ${source.seed.driver}`);
    }
    if (source.seed.scale && source.seed.scale !== input.scale) {
      mismatches.push(`scale expected ${input.scale}, got ${source.seed.scale}`);
    }
    if (source.seed.targetQuads !== undefined && source.seed.targetQuads !== input.targetQuads) {
      mismatches.push(`targetQuads expected ${input.targetQuads}, got ${source.seed.targetQuads}`);
    }
    if (source.seed.caseProfile && source.seed.caseProfile !== input.caseProfile) {
      mismatches.push(`caseProfile expected ${input.caseProfile}, got ${source.seed.caseProfile}`);
    }
    if (source.seed.textSearchBackend && source.seed.textSearchBackend !== input.textSearchBackend) {
      mismatches.push(`textSearchBackend expected ${input.textSearchBackend}, got ${source.seed.textSearchBackend}`);
    }
    if (mismatches.length > 0) {
      throw new Error(`benchmark gate report shape mismatch: ${mismatches.join('; ')}`);
    }
  }
}

function calibratedScannedRowsThreshold(value: unknown, name: string): number {
  return Math.ceil(nonNegativeNumber(value, name) * 1.25);
}

function calibratedP95DurationThreshold(value: unknown, name: string): number {
  const durationMs = nonNegativeNumber(value, name);
  return Math.ceil(Math.max(durationMs * 1.25, durationMs + 25));
}

function calibratedMaxDurationThreshold(value: unknown, name: string): number {
  return Math.ceil(nonNegativeNumber(value, name) * 1.5);
}

function maxDurationFromReportCase(rawCase: Record<string, unknown>): number {
  if (Array.isArray(rawCase.durationsMs) && rawCase.durationsMs.length > 0) {
    return Math.max(...rawCase.durationsMs.map((value, index) => nonNegativeNumber(value, `queryCases.${rawCase.name}.durationsMs[${index}]`)));
  }
  return nonNegativeNumber(rawCase.p95DurationMs, `queryCases.${rawCase.name}.p95DurationMs`);
}

function readBenchmarkGateBaselineReport(
  filePath: string,
  options: { calibratedLimits?: boolean } = {},
): Record<string, RdfModelPostgresBenchmarkGateBaseline> {
  const resolvedPath = path.resolve(filePath);
  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('--benchmarkGateBaselineReport must point to a JSON object');
  }
  const report = isRecord(parsed.report) ? parsed.report : parsed;
  if (!isRecord(report)) {
    throw new Error('--benchmarkGateBaselineReport must contain a report object');
  }
  if (!Array.isArray(report.queryCases)) {
    throw new Error('--benchmarkGateBaselineReport report.queryCases must be an array');
  }
  const fusionCaseNames = fusionBenchmarkCaseNamesFromReport(report);
  const baselines: Record<string, RdfModelPostgresBenchmarkGateBaseline> = {};
  for (const rawCase of report.queryCases) {
    if (!isRecord(rawCase) || typeof rawCase.name !== 'string') {
      continue;
    }
    if (fusionCaseNames.size > 0 && !fusionCaseNames.has(rawCase.name)) {
      continue;
    }
    const scannedRows = nonNegativeNumber(rawCase.scannedRows, `queryCases.${rawCase.name}.scannedRows`);
    const p95DurationMs = nonNegativeNumber(rawCase.p95DurationMs, `queryCases.${rawCase.name}.p95DurationMs`);
    baselines[rawCase.name] = {
      label: `baseline-report:${path.basename(resolvedPath)}`,
      scannedRows,
      p95DurationMs,
      ...(options.calibratedLimits ? {
        maxScannedRows: calibratedScannedRowsThreshold(scannedRows, `queryCases.${rawCase.name}.scannedRows`),
        maxP95DurationMs: calibratedP95DurationThreshold(p95DurationMs, `queryCases.${rawCase.name}.p95DurationMs`),
        maxDurationMs: calibratedMaxDurationThreshold(maxDurationFromReportCase(rawCase), `queryCases.${rawCase.name}.durationsMs`),
      } : {}),
    };
  }
  if (Object.keys(baselines).length === 0) {
    throw new Error('--benchmarkGateBaselineReport did not contain any fusion query case baselines');
  }
  return baselines;
}

function fusionBenchmarkCaseNamesFromReport(report: Record<string, unknown>): Set<string> {
  return benchmarkGateCaseNamesFromReport(report, 'fusionBenchmarkGate');
}

function benchmarkGateCaseNamesFromReport(
  report: Record<string, unknown>,
  gateName: 'servingRegressionGate' | 'fusionBenchmarkGate',
): Set<string> {
  const gate = report[gateName];
  if (!isRecord(gate) || !Array.isArray(gate.cases)) {
    return new Set();
  }
  return new Set(gate.cases
    .filter(isRecord)
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string'));
}

function benchmarkGateThresholds(value: unknown, label: string): RdfModelPostgresBenchmarkGateThresholds {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return {
    ...(value.maxScannedRows !== undefined ? { maxScannedRows: nonNegativeNumber(value.maxScannedRows, `${label}.maxScannedRows`) } : {}),
    ...(value.maxP95DurationMs !== undefined ? { maxP95DurationMs: nonNegativeNumber(value.maxP95DurationMs, `${label}.maxP95DurationMs`) } : {}),
    ...(value.cases !== undefined ? { cases: benchmarkGateCaseThresholds(value.cases, `${label}.cases`) } : {}),
  };
}

function benchmarkGateCaseThresholds(value: unknown, label: string): Record<string, RdfModelPostgresBenchmarkGateCaseThresholds> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const thresholds: Record<string, RdfModelPostgresBenchmarkGateCaseThresholds> = {};
  for (const [caseName, rawThresholds] of Object.entries(value)) {
    if (!isRecord(rawThresholds)) {
      throw new Error(`${label}.${caseName} must be a JSON object`);
    }
    thresholds[caseName] = {
      ...(rawThresholds.maxScannedRows !== undefined ? { maxScannedRows: nonNegativeNumber(rawThresholds.maxScannedRows, `${label}.${caseName}.maxScannedRows`) } : {}),
      ...(rawThresholds.maxP95DurationMs !== undefined ? { maxP95DurationMs: nonNegativeNumber(rawThresholds.maxP95DurationMs, `${label}.${caseName}.maxP95DurationMs`) } : {}),
    };
  }
  return thresholds;
}

function benchmarkGateBaselines(value: unknown): Record<string, RdfModelPostgresBenchmarkGateBaseline> {
  if (!isRecord(value)) {
    throw new Error('fusionBenchmarkBaselines must be a JSON object');
  }
  const baselines: Record<string, RdfModelPostgresBenchmarkGateBaseline> = {};
  for (const [caseName, baseline] of Object.entries(value)) {
    if (!isRecord(baseline)) {
      throw new Error(`fusionBenchmarkBaselines.${caseName} must be a JSON object`);
    }
    baselines[caseName] = {
      ...(typeof baseline.label === 'string' ? { label: baseline.label } : {}),
      ...(baseline.scannedRows !== undefined ? { scannedRows: nonNegativeNumber(baseline.scannedRows, `fusionBenchmarkBaselines.${caseName}.scannedRows`) } : {}),
      ...(baseline.p95DurationMs !== undefined ? { p95DurationMs: nonNegativeNumber(baseline.p95DurationMs, `fusionBenchmarkBaselines.${caseName}.p95DurationMs`) } : {}),
      ...(baseline.maxScannedRows !== undefined ? { maxScannedRows: nonNegativeNumber(baseline.maxScannedRows, `fusionBenchmarkBaselines.${caseName}.maxScannedRows`) } : {}),
      ...(baseline.maxP95DurationMs !== undefined ? { maxP95DurationMs: nonNegativeNumber(baseline.maxP95DurationMs, `fusionBenchmarkBaselines.${caseName}.maxP95DurationMs`) } : {}),
      ...(baseline.maxDurationMs !== undefined ? { maxDurationMs: nonNegativeNumber(baseline.maxDurationMs, `fusionBenchmarkBaselines.${caseName}.maxDurationMs`) } : {}),
    };
  }
  return baselines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
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
    || value === 'pg-hot-operators';
}

function isPostgresRdfTextSearchBackend(value: string): value is PostgresRdfTextSearchBackend {
  return value === 'posting'
    || value === 'pg-native-fts'
    || value === 'auto';
}

function isRdfBenchmarkCaseProfile(value: string): value is RdfBenchmarkCaseProfile {
  return value === 'default' || value === 'extreme' || value === 'fusion' || value === 'all';
}

function rdfAccelerationProfileMatched(profile: RdfPgAccelerationProfile, storage: RdfEngineStorageStats): boolean {
  const stats = storage.pgAcceleration;
  if (profile === 'baseline') {
    return stats?.profile === 'baseline' && stats.enabled === false;
  }
  return stats?.profile === profile && stats.enabled === true;
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
  const searchIndexes = benchmarkSearchIndexOptions(options);
  if (options.driver === 'pglite') {
    return new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: paths.pgliteDataDir,
      queryResultCacheEnabled: false,
      rdfAccelerationProfile: options.rdfAccelerationProfile,
      ...searchIndexes,
    });
  }
  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString: options.connectionString,
    queryResultCacheEnabled: false,
    rdfAccelerationProfile: options.rdfAccelerationProfile,
    ...searchIndexes,
  });
}

export function benchmarkSearchIndexOptions(options: Pick<CliOptions,
  'caseProfile' | 'connectionString' | 'driver' | 'textSearchBackend'
>): Pick<PostgresRdfEngineOptions, 'textIndex' | 'vectorIndex'> {
  if (!rdfModelsBenchmarkProfileRequiresSearchFusion(options.caseProfile)) {
    return {};
  }

  const pgConnection = options.driver === 'pg'
    ? { driver: 'pg' as const, connectionString: options.connectionString }
    : undefined;
  return {
    textIndex: options.textSearchBackend === 'posting'
      ? { path: ':memory:' }
      : pgConnection
        ? { ...pgConnection, textSearchBackend: options.textSearchBackend }
        : { driver: 'pglite', textSearchBackend: options.textSearchBackend },
    vectorIndex: pgConnection ?? { path: ':memory:' },
  };
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

function seedSummary(
  options: CliOptions,
  seedQuadCount: number,
  ingestDurationMs: number,
  storage: RdfEngineStorageStats,
): Record<string, unknown> {
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
    textSearchBackend: options.textSearchBackend,
    ...(options.benchmarkGateConfigSources ? { benchmarkGateConfigSources: options.benchmarkGateConfigSources } : {}),
    seedQuadCount,
    targetQuadCount: options.targetQuads,
    fullScale: rdfModelsBenchmarkTargetSatisfied(options.targetQuads, seedQuadCount),
    ingestDurationMs,
    bulkLoad: storage.bulkLoad,
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
  seedIngestDurationMs: number;
  seedBulkLoad?: RdfEngineStorageStats['bulkLoad'];
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
  console.log(`  serving thresholds configured: ${summary.options.servingRegressionThresholds ? 'yes' : 'no'}`);
  console.log(`  fusion thresholds configured: ${summary.options.fusionBenchmarkThresholds ? 'yes' : 'no'}`);
  console.log(`  fusion baselines configured: ${summary.options.fusionBenchmarkBaselines ? Object.keys(summary.options.fusionBenchmarkBaselines).length : 0}`);
  console.log(`  seed quads: ${summary.seedQuadCount}`);
  console.log(`  target quads: ${summary.targetQuadCount}`);
  console.log(`  seed ingest duration ms: ${summary.seedIngestDurationMs}`);
  if (summary.seedBulkLoad) {
    console.log(`  seed COPY rows: ${summary.seedBulkLoad.copyFromRows.rows}`);
    console.log(`  seed COPY succeeded/fallbacks: ${summary.seedBulkLoad.copyFromRows.succeeded}/${summary.seedBulkLoad.copyFromRows.fallbacks}`);
    console.log(`  seed COPY tables: ${summary.seedBulkLoad.copyFromRows.tables.map((table) => `${table.kind}:${table.statements}/${table.rows}`).join(', ') || 'none'}`);
  }
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
  --rdfAccelerationProfile=VALUE   baseline|pg-result-cache|pg-hot-operators. Default: baseline
  --textSearchBackend=VALUE        posting|pg-native-fts|auto. Default: posting
  --benchmarkGateConfig=PATH       JSON file with serving/fusion thresholds and fusion baselines
  --benchmarkGateConfigFromReport=PATH
                                   Derive per-case thresholds and fusion baselines from a report artifact
  --benchmarkGateBaselineReport=PATH
                                   Read fusion baselines from a prior benchmark report artifact
  --out=PATH                       Output directory. Default: .test-data/rdf-engine
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
