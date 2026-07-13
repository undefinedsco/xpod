import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RdfBenchmarkReportCatalog } from '../src/api/service/RdfBenchmarkReportCatalog';
import {
  evaluateRdfBenchmarkReportGate,
  type RdfBenchmarkReportGateOptions,
} from '../src/api/service/RdfBenchmarkReportGate';

interface CliOptions extends RdfBenchmarkReportGateOptions {
  roots: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const catalog = new RdfBenchmarkReportCatalog({
    roots: options.roots.length > 0 ? options.roots : undefined,
    cacheTtlMs: 0,
  });
  const snapshot = await catalog.snapshot();
  const result = evaluateRdfBenchmarkReportGate(snapshot, options);
  printResult(result);
  if (!result.matched) {
    process.exitCode = 1;
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { roots: [] };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('--root=')) {
      options.roots.push(path.resolve(arg.slice('--root='.length)));
      continue;
    }
    if (arg.startsWith('--scale=')) {
      options.requiredScale = arg.slice('--scale='.length);
      continue;
    }
    if (arg.startsWith('--driver=')) {
      options.requiredDriver = arg.slice('--driver='.length);
      continue;
    }
    if (arg.startsWith('--caseProfile=')) {
      options.requiredCaseProfile = arg.slice('--caseProfile='.length);
      continue;
    }
    if (arg.startsWith('--rdfAccelerationProfile=')) {
      options.requiredRdfAccelerationProfile = arg.slice('--rdfAccelerationProfile='.length);
      continue;
    }
    if (arg.startsWith('--textSearchBackend=')) {
      options.requiredTextSearchBackend = arg.slice('--textSearchBackend='.length);
      continue;
    }
    if (arg.startsWith('--minTargetQuads=')) {
      options.minTargetQuadCount = positiveInteger(arg.slice('--minTargetQuads='.length), '--minTargetQuads');
      continue;
    }
    if (arg.startsWith('--minSeedQuads=')) {
      options.minSeedQuadCount = positiveInteger(arg.slice('--minSeedQuads='.length), '--minSeedQuads');
      continue;
    }
    if (arg.startsWith('--minIterations=')) {
      options.minIterations = positiveInteger(arg.slice('--minIterations='.length), '--minIterations');
      continue;
    }
    if (arg.startsWith('--minWarmupIterations=')) {
      options.minWarmupIterations = nonNegativeInteger(arg.slice('--minWarmupIterations='.length), '--minWarmupIterations');
      continue;
    }
    if (arg.startsWith('--minConcurrency=')) {
      options.minConcurrency = positiveInteger(arg.slice('--minConcurrency='.length), '--minConcurrency');
      continue;
    }
    if (arg === '--allowPartialScale') {
      options.requireFullScale = false;
      continue;
    }
    if (arg === '--allowCopyFallbacks') {
      options.allowCopyFallbacks = true;
      continue;
    }
    if (arg === '--noCopyIngest') {
      options.requireCopyIngest = false;
      continue;
    }
    if (arg === '--noPlannerStats') {
      options.requirePlannerStats = false;
      continue;
    }
    if (arg === '--noColdWarmTimings') {
      options.requireColdWarmTimings = false;
      continue;
    }
    if (arg === '--noStorageRatio') {
      options.requireStorageRatio = false;
      continue;
    }
    if (arg === '--requireServingRegressionGate') {
      options.requireServingRegressionGate = true;
      continue;
    }
    if (arg === '--requireServingRegressionThresholds') {
      options.requireServingRegressionThresholds = true;
      continue;
    }
    if (arg === '--requireFusionBenchmarkGate') {
      options.requireFusionBenchmarkGate = true;
      continue;
    }
    if (arg === '--requireFusionBenchmarkThresholds') {
      options.requireFusionBenchmarkThresholds = true;
      continue;
    }
    if (arg === '--requireFusionBaselineComparison') {
      options.requireFusionBaselineComparison = true;
      continue;
    }
    if (arg === '--requireBenchmarkGateConfigSources') {
      options.requireBenchmarkGateConfigSources = true;
      continue;
    }
    if (arg === '--requireFusionBaselineReportSource') {
      options.requireFusionBaselineReportSource = true;
      continue;
    }
    if (arg === '--requireFusionBaselineSourceBaselineProfile') {
      options.requireFusionBaselineSourceBaselineProfile = true;
      continue;
    }
    if (arg === '--requireFusionHardFilterEvidence') {
      options.requireFusionHardFilterEvidence = true;
      continue;
    }
    if (arg === '--requireFusionBatchedBroadCandidateJoinEvidence') {
      options.requireFusionBatchedBroadCandidateJoinEvidence = true;
      continue;
    }
    if (arg === '--requireNativeTextFtsEvidence') {
      options.requireNativeTextFtsEvidence = true;
      continue;
    }
    if (arg === '--requireNativeVectorEvidence') {
      options.requireNativeVectorEvidence = true;
      continue;
    }
    if (arg === '--strictP3FusionGate') {
      applyStrictP3FusionGate(options);
      continue;
    }
    if (arg === '--productP3FusionGate') {
      applyProductP3FusionGate(options);
      continue;
    }
    if (arg === '--productNativePlannerGate') {
      applyProductNativePlannerGate(options);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function applyStrictP3FusionGate(options: CliOptions): void {
  options.requiredCaseProfile = 'all';
  options.minIterations = 3;
  options.minWarmupIterations = 1;
  options.requireServingRegressionGate = true;
  options.requireServingRegressionThresholds = true;
  options.requireFusionBenchmarkGate = true;
  options.requireFusionBenchmarkThresholds = true;
  options.requireFusionBaselineComparison = true;
  options.requireBenchmarkGateConfigSources = true;
  options.requireFusionBaselineReportSource = true;
  options.requireFusionBaselineSourceBaselineProfile = true;
  options.requireFusionHardFilterEvidence = true;
}

function applyProductP3FusionGate(options: CliOptions): void {
  applyStrictP3FusionGate(options);
  options.requiredScale = 'large';
  options.requiredDriver = 'pg';
  options.minTargetQuadCount = 1_000_000;
  options.minSeedQuadCount = 1_000_000;
  options.minConcurrency = 4;
  options.requireFullScale = true;
  options.requireCopyIngest = true;
  options.requireFusionBatchedBroadCandidateJoinEvidence = true;
}

function applyProductNativePlannerGate(options: CliOptions): void {
  applyProductP3FusionGate(options);
  options.requiredTextSearchBackend = 'pg-native-fts';
  options.requireNativeTextFtsEvidence = true;
  options.requireNativeVectorEvidence = true;
}

function printResult(result: ReturnType<typeof evaluateRdfBenchmarkReportGate>): void {
  console.log('[rdf-benchmark-report-gate]');
  console.log(`  matched: ${result.matched}`);
  console.log(`  checked reports: ${result.checkedReportCount}`);
  console.log(`  required scale: ${result.required.requiredScale}`);
  console.log(`  required driver: ${result.required.requiredDriver}`);
  if (result.required.requiredCaseProfile) {
    console.log(`  required case profile: ${result.required.requiredCaseProfile}`);
  }
  console.log(`  min target quads: ${result.required.minTargetQuadCount}`);
  console.log(`  min seed quads: ${result.required.minSeedQuadCount}`);
  console.log(`  min iterations: ${result.required.minIterations}`);
  console.log(`  min warmup iterations: ${result.required.minWarmupIterations}`);
  console.log(`  min concurrency: ${result.required.minConcurrency}`);
  console.log(`  require serving regression gate: ${result.required.requireServingRegressionGate}`);
  console.log(`  require serving regression thresholds: ${result.required.requireServingRegressionThresholds}`);
  console.log(`  require fusion benchmark gate: ${result.required.requireFusionBenchmarkGate}`);
  console.log(`  require fusion benchmark thresholds: ${result.required.requireFusionBenchmarkThresholds}`);
  console.log(`  require fusion baseline comparison: ${result.required.requireFusionBaselineComparison}`);
  console.log(`  require benchmark gate config sources: ${result.required.requireBenchmarkGateConfigSources}`);
  console.log(`  require fusion baseline report source: ${result.required.requireFusionBaselineReportSource}`);
  console.log(`  require fusion baseline source baseline profile: ${result.required.requireFusionBaselineSourceBaselineProfile}`);
  console.log(`  require fusion hard-filter evidence: ${result.required.requireFusionHardFilterEvidence}`);
  console.log(`  require fusion batched broad candidate join evidence: ${result.required.requireFusionBatchedBroadCandidateJoinEvidence}`);
  console.log(`  require native text FTS evidence: ${result.required.requireNativeTextFtsEvidence}`);
  console.log(`  require native vector evidence: ${result.required.requireNativeVectorEvidence}`);
  if (result.required.requiredRdfAccelerationProfile) {
    console.log(`  required acceleration: ${result.required.requiredRdfAccelerationProfile}`);
  }
  if (result.required.requiredTextSearchBackend) {
    console.log(`  required text backend: ${result.required.requiredTextSearchBackend}`);
  }
  if (result.matchedReport) {
    console.log(`  report: ${result.matchedReport.path}`);
    console.log(`  generated: ${result.matchedReport.generatedAt}`);
    console.log(`  seed/target quads: ${result.matchedReport.seedQuadCount ?? '-'} / ${result.matchedReport.targetQuadCount ?? '-'}`);
    console.log(`  warm p95: ${result.matchedReport.warmP95DurationMs ?? '-'} ms`);
    console.log(`  storage ratio: ${result.matchedReport.storageTotalToFactsRatio ?? '-'}`);
    return;
  }
  for (const reason of result.failedReasons) {
    console.error(`  failed: ${reason}`);
  }
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/assert-rdf-benchmark-report-gate.ts [options]

Options:
  --root=PATH                       Report root. Repeatable. Default: .test-data
  --scale=VALUE                     Required report scale. Default: large
  --driver=VALUE                    Required seed driver. Default: pg
  --caseProfile=VALUE               Require a specific benchmark case profile
  --rdfAccelerationProfile=VALUE    Require a specific RDF acceleration profile
  --textSearchBackend=VALUE         Require a specific text search backend
  --minTargetQuads=N                Required target quad count. Default: 1000000
  --minSeedQuads=N                  Required generated seed quad count. Default: minTargetQuads
  --minIterations=N                 Required benchmark iterations. Default: 1
  --minWarmupIterations=N           Required warmup iterations. Default: 0
  --minConcurrency=N                Required concurrency gate lanes. Default: 4
  --allowPartialScale               Do not require seed.fullScale=true
  --allowCopyFallbacks              Allow COPY fallback count to be greater than zero
  --noCopyIngest                    Do not require COPY ingest counters
  --noPlannerStats                  Do not require refresh/planner stats evidence
  --noColdWarmTimings               Do not require cold/warm timing evidence
  --noStorageRatio                  Do not require storage ratio evidence
  --requireServingRegressionGate    Require serving regression gate evidence to pass
  --requireServingRegressionThresholds Require serving regression thresholds to be configured
  --requireFusionBenchmarkGate      Require fusion benchmark gate evidence to pass
  --requireFusionBenchmarkThresholds Require fusion benchmark thresholds to be configured
  --requireFusionBaselineComparison Require fusion baseline comparison evidence to pass
  --requireBenchmarkGateConfigSources Require benchmark gate threshold/config sources to be recorded
  --requireFusionBaselineReportSource Require fusion baseline source to be report-derived
  --requireFusionBaselineSourceBaselineProfile Require fusion baseline source to use rdfAccelerationProfile=baseline
  --requireFusionHardFilterEvidence Require fusion benchmark cases to include hard-filter-before-rank evidence
  --requireFusionBatchedBroadCandidateJoinEvidence Require broad fusion cases to include batched join evidence
  --requireNativeTextFtsEvidence   Require query plans to show PG-native FTS evidence
  --requireNativeVectorEvidence    Require query plans to show PG-native vector evidence
  --strictP3FusionGate              Require all-profile serving, fusion, baseline, and stable timing gates
  --productP3FusionGate             Require large PG product-scale strict gate plus batched broad-candidate evidence
  --productNativePlannerGate        Require product P3 gate plus PG-native text/vector evidence
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
