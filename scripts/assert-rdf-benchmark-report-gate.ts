import * as path from 'node:path';
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

function parseArgs(args: string[]): CliOptions {
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
    if (arg.startsWith('--rdfAccelerationProfile=')) {
      options.requiredRdfAccelerationProfile = arg.slice('--rdfAccelerationProfile='.length);
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printResult(result: ReturnType<typeof evaluateRdfBenchmarkReportGate>): void {
  console.log('[rdf-benchmark-report-gate]');
  console.log(`  matched: ${result.matched}`);
  console.log(`  checked reports: ${result.checkedReportCount}`);
  console.log(`  required scale: ${result.required.requiredScale}`);
  console.log(`  required driver: ${result.required.requiredDriver}`);
  console.log(`  min target quads: ${result.required.minTargetQuadCount}`);
  console.log(`  min seed quads: ${result.required.minSeedQuadCount}`);
  console.log(`  min concurrency: ${result.required.minConcurrency}`);
  if (result.required.requiredRdfAccelerationProfile) {
    console.log(`  required acceleration: ${result.required.requiredRdfAccelerationProfile}`);
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

function printHelp(): void {
  console.log(`Usage: bun scripts/assert-rdf-benchmark-report-gate.ts [options]

Options:
  --root=PATH                       Report root. Repeatable. Default: .test-data
  --scale=VALUE                     Required report scale. Default: large
  --driver=VALUE                    Required seed driver. Default: pg
  --rdfAccelerationProfile=VALUE    Require a specific RDF acceleration profile
  --minTargetQuads=N                Required target quad count. Default: 1000000
  --minSeedQuads=N                  Required generated seed quad count. Default: minTargetQuads
  --minConcurrency=N                Required concurrency gate lanes. Default: 4
  --allowPartialScale               Do not require seed.fullScale=true
  --allowCopyFallbacks              Allow COPY fallback count to be greater than zero
  --noCopyIngest                    Do not require COPY ingest counters
  --noPlannerStats                  Do not require refresh/planner stats evidence
  --noColdWarmTimings               Do not require cold/warm timing evidence
  --noStorageRatio                  Do not require storage ratio evidence
`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
