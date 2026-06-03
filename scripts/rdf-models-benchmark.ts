import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteQuintStore } from '../src/storage/quint';
import {
  RDF_MODELS_BENCHMARK_POD,
  RdfQuadIndex,
  Rdf3xIndex,
  ShadowRdfQuintStore,
  SolidRdfEngine,
  buildRdfModelsBenchmarkSeed,
  defaultSyntheticMessagesForRdfModelsScale,
  runRdfModelsBenchmark,
  runRdfModelsRdf3xShadowBenchmark,
  runRdfModelsShadowBenchmark,
  rdfModelsBenchmarkScaleSatisfied,
  rdfModelsBenchmarkSyntheticPodCount,
  rdfModelsBenchmarkScaleTargetQuads,
  type RdfBenchmarkScale,
  type RdfEngineStorageStats,
} from '../src/storage/rdf';

interface CliOptions {
  outDir: string;
  scale: RdfBenchmarkScale;
  iterations: number;
  syntheticMessages: number;
  syntheticMessagesOverridden: boolean;
  syntheticPodCount: number;
}

interface BenchmarkPaths {
  compatibilityDb: string;
  indexDb: string;
  baselineReport: string;
  shadowReport: string;
  rdf3xShadowReport: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });

  const paths = createBenchmarkPaths(options.outDir);
  const compatibilityStore = new SqliteQuintStore({ path: paths.compatibilityDb });
  const shadowStore = new ShadowRdfQuintStore({
    compatibilityStore,
    index: new RdfQuadIndex({ path: paths.indexDb }),
  });

  try {
    await shadowStore.open();

    const seedQuads = buildRdfModelsBenchmarkSeed(options);
    await compatibilityStore.multiPut(seedQuads);
    const backfill = await shadowStore.backfillShadowIndex({
      clear: true,
      batchSize: 1000,
    });

    const rdf3xIndex = new Rdf3xIndex({ path: paths.indexDb });
    rdf3xIndex.open();
    const engine = new SolidRdfEngine({
      index: shadowStore.index,
      rdf3xIndex,
    });
    const baseline = runRdfModelsBenchmark(engine, {
      scale: options.scale,
      iterations: options.iterations,
    });
    const shadow = await runRdfModelsShadowBenchmark(engine, compatibilityStore, {
      scale: options.scale,
      iterations: options.iterations,
    });
    const rdf3xShadow = runRdfModelsRdf3xShadowBenchmark(engine, {
      scale: options.scale,
      iterations: options.iterations,
    });

    await writeJson(paths.baselineReport, {
      seed: seedSummary(options, seedQuads.length, backfill),
      report: baseline,
    });
    await writeJson(paths.shadowReport, {
      seed: seedSummary(options, seedQuads.length, backfill),
      report: shadow,
    });
    await writeJson(paths.rdf3xShadowReport, {
      seed: seedSummary(options, seedQuads.length, backfill),
      report: rdf3xShadow,
    });

    printSummary({
      options,
      paths,
      seedQuadCount: seedQuads.length,
      targetQuadCount: rdfModelsBenchmarkScaleTargetQuads(options.scale),
      fullScale: rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuads.length),
      syntheticPodCount: options.syntheticPodCount,
      backfilledRows: backfill.indexedRows,
      baselineCases: baseline.cases.length,
      queryCases: baseline.queryCases.length,
      shadowCases: shadow.cases.length,
      rdf3xShadowCases: rdf3xShadow.cases.length,
      rdf3xShadowJoinCases: rdf3xShadow.joinCases.length,
      rdf3xSkippedCases: rdf3xShadow.skippedCases,
      rdf3xSkippedJoinCases: rdf3xShadow.skippedJoinCases,
      matched: shadow.matched,
      orderedMatched: shadow.orderedMatched,
      rdf3xMatched: rdf3xShadow.matched,
      rdf3xOrderedMatched: rdf3xShadow.orderedMatched,
      baselinePlanMatched: baseline.planMatched,
      shadowPlanMatched: shadow.planMatched,
      rdf3xPlanMatched: rdf3xShadow.planMatched,
      shadowSpaceGateEnforced: shadow.spaceGateEnforced,
      shadowPerformanceMatched: shadow.performanceMatched,
      shadowSpaceMatched: shadow.spaceMatched,
      failedPlanCases: [...new Set([
        ...baseline.failedPlanCases,
        ...shadow.failedPlanCases,
      ])],
      failedRdf3xPlanCases: rdf3xShadow.failedPlanCases,
      failedPerformanceCases: shadow.failedPerformanceCases,
      failedSpaceCases: shadow.failedSpaceCases,
      failedCases: shadow.cases
        .filter((testCase) => !testCase.matched || !testCase.orderedMatch)
        .map((testCase) => testCase.name),
      failedRdf3xCases: rdf3xShadow.failedCases,
      failedRdf3xJoinCases: rdf3xShadow.failedJoinCases,
      storage: rdf3xShadow.storage,
    });

    if (
      !shadow.matched
      || !shadow.orderedMatched
      || !rdf3xShadow.matched
      || !rdf3xShadow.orderedMatched
      || !baseline.planMatched
      || !shadow.planMatched
      || !rdf3xShadow.planMatched
      || !shadow.performanceMatched
      || !shadow.spaceMatched
      || !rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuads.length)
    ) {
      process.exitCode = 1;
    }
  } finally {
    await shadowStore.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  let outDir = path.join(process.cwd(), '.test-data', 'rdf-engine');
  let scale: RdfBenchmarkScale = 'medium';
  let iterations = 3;
  let syntheticMessages: number | undefined;

  for (const arg of args) {
    if (arg.startsWith('--out=')) {
      outDir = path.resolve(arg.slice('--out='.length));
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
    if (arg.startsWith('--syntheticMessages=')) {
      syntheticMessages = positiveInteger(arg.slice('--syntheticMessages='.length), '--syntheticMessages');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    outDir,
    scale,
    iterations,
    syntheticMessages: syntheticMessages ?? defaultSyntheticMessagesForRdfModelsScale(scale),
    syntheticMessagesOverridden: syntheticMessages !== undefined,
    syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount(scale),
  };
}

function positiveInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function createBenchmarkPaths(outDir: string): BenchmarkPaths {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${stamp}-${process.pid}-${randomUUID()}`;
  return {
    compatibilityDb: path.join(outDir, `rdf-models-compat-${runId}.sqlite`),
    indexDb: path.join(outDir, `rdf-models-index-${runId}.sqlite`),
    baselineReport: path.join(outDir, `models-baseline-${runId}.json`),
    shadowReport: path.join(outDir, `models-shadow-${runId}.json`),
    rdf3xShadowReport: path.join(outDir, `models-rdf3x-shadow-${runId}.json`),
  };
}

function seedSummary(
  options: CliOptions,
  seedQuadCount: number,
  backfill: { scannedRows: number; indexedRows: number; batchCount: number; durationMs: number },
): Record<string, unknown> {
  return {
    pod: RDF_MODELS_BENCHMARK_POD,
    scale: options.scale,
    iterations: options.iterations,
    syntheticMessages: options.syntheticMessages,
    syntheticMessagesOverridden: options.syntheticMessagesOverridden,
    syntheticPodCount: options.syntheticPodCount,
    seedQuadCount,
    targetQuadCount: rdfModelsBenchmarkScaleTargetQuads(options.scale),
    fullScale: rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuadCount),
    backfill,
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
  syntheticPodCount: number;
  backfilledRows: number;
  baselineCases: number;
  queryCases: number;
  shadowCases: number;
  rdf3xShadowCases: number;
  rdf3xShadowJoinCases: number;
  rdf3xSkippedCases: string[];
  rdf3xSkippedJoinCases: string[];
  matched: boolean;
  orderedMatched: boolean;
  rdf3xMatched: boolean;
  rdf3xOrderedMatched: boolean;
  baselinePlanMatched: boolean;
  shadowPlanMatched: boolean;
  rdf3xPlanMatched: boolean;
  shadowSpaceGateEnforced: boolean;
  shadowPerformanceMatched: boolean;
  shadowSpaceMatched: boolean;
  failedPlanCases: string[];
  failedRdf3xPlanCases: string[];
  failedPerformanceCases: string[];
  failedSpaceCases: string[];
  failedCases: string[];
  failedRdf3xCases: string[];
  failedRdf3xJoinCases: string[];
  storage: RdfEngineStorageStats;
}): void {
  console.log('RDF models benchmark complete');
  console.log(`  scale: ${summary.options.scale}`);
  console.log(`  iterations: ${summary.options.iterations}`);
  console.log(`  seed quads: ${summary.seedQuadCount}`);
  console.log(`  target quads: ${summary.targetQuadCount}`);
  console.log(`  full scale seed: ${summary.fullScale}`);
  console.log(`  synthetic pods: ${summary.syntheticPodCount}`);
  if (summary.options.syntheticMessagesOverridden && !summary.fullScale) {
    console.error('  syntheticMessages override is below the selected scale target');
  }
  console.log(`  backfilled rows: ${summary.backfilledRows}`);
  console.log(`  baseline cases: ${summary.baselineCases}`);
  console.log(`  query cases: ${summary.queryCases}`);
  console.log(`  shadow cases: ${summary.shadowCases}`);
  console.log(`  rdf3x shadow cases: ${summary.rdf3xShadowCases}`);
  console.log(`  rdf3x shadow join cases: ${summary.rdf3xShadowJoinCases}`);
  console.log(`  rdf3x skipped cases: ${summary.rdf3xSkippedCases.length}`);
  console.log(`  rdf3x skipped join cases: ${summary.rdf3xSkippedJoinCases.length}`);
  console.log(`  shadow matched: ${summary.matched}`);
  console.log(`  shadow ordered matched: ${summary.orderedMatched}`);
  console.log(`  rdf3x shadow matched: ${summary.rdf3xMatched}`);
  console.log(`  rdf3x shadow ordered matched: ${summary.rdf3xOrderedMatched}`);
  console.log(`  baseline plan matched: ${summary.baselinePlanMatched}`);
  console.log(`  shadow plan matched: ${summary.shadowPlanMatched}`);
  console.log(`  rdf3x plan matched: ${summary.rdf3xPlanMatched}`);
  console.log(`  shadow performance matched: ${summary.shadowPerformanceMatched}`);
  console.log(`  shadow space matched: ${summary.shadowSpaceMatched}${summary.shadowSpaceGateEnforced ? '' : ' (not enforced for this scale)'}`);
  console.log(`  storage profile: ${summary.storage.derivedIndexProfile}`);
  console.log(`  storage facts bytes: ${summary.storage.factsBytes}`);
  console.log(`  storage derived bytes: ${summary.storage.derivedBytes}`);
  console.log(`  storage total/facts ratio: ${formatRatio(summary.storage.totalToFactsRatio)}`);
  console.log(`  baseline report: ${summary.paths.baselineReport}`);
  console.log(`  shadow report: ${summary.paths.shadowReport}`);
  console.log(`  rdf3x shadow report: ${summary.paths.rdf3xShadowReport}`);
  if (summary.failedPlanCases.length > 0) {
    console.error(`  failed plan cases: ${summary.failedPlanCases.join(', ')}`);
  }
  if (summary.failedRdf3xPlanCases.length > 0) {
    console.error(`  failed rdf3x plan cases: ${summary.failedRdf3xPlanCases.join(', ')}`);
  }
  if (summary.failedCases.length > 0) {
    console.error(`  failed cases: ${summary.failedCases.join(', ')}`);
  }
  if (summary.failedRdf3xCases.length > 0) {
    console.error(`  failed rdf3x cases: ${summary.failedRdf3xCases.join(', ')}`);
  }
  if (summary.failedRdf3xJoinCases.length > 0) {
    console.error(`  failed rdf3x join cases: ${summary.failedRdf3xJoinCases.join(', ')}`);
  }
  if (summary.failedPerformanceCases.length > 0) {
    console.error(`  failed performance cases: ${summary.failedPerformanceCases.join(', ')}`);
  }
  if (summary.failedSpaceCases.length > 0) {
    console.error(`  failed space cases: ${summary.failedSpaceCases.join(', ')}`);
  }
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'Infinity';
}

function printHelp(): void {
  console.log(`Usage: bun scripts/rdf-models-benchmark.ts [options]

Options:
  --scale=small|medium|large       Select benchmark case scale. Default: medium
  --iterations=N                   Iterations per case. Default: 3
  --syntheticMessages=N            Override generated message count for storage-size tests
  --out=PATH                       Output directory. Default: .test-data/rdf-engine
`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
