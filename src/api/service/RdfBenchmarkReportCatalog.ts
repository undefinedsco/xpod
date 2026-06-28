import * as path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { PACKAGE_ROOT } from '../../runtime/package-root';

const DEFAULT_MAX_REPORTS = 20;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_REPORT_BYTES = 25 * 1024 * 1024;

export interface RdfBenchmarkReportCatalogOptions {
  roots?: string[];
  packageRoot?: string;
  maxReports?: number;
  maxDepth?: number;
  cacheTtlMs?: number;
}

export interface RdfBenchmarkReportCatalogSnapshot {
  roots: string[];
  reportCount: number;
  skippedFiles: number;
  errors: RdfBenchmarkReportCatalogError[];
  reports: RdfBenchmarkReportSummary[];
}

export interface RdfBenchmarkReportCatalogError {
  path: string;
  message: string;
}

export interface RdfBenchmarkReportSummary {
  id: string;
  path: string;
  generatedAt: string;
  engine: string;
  driver?: string;
  scale?: string;
  caseProfile?: string;
  rdfAccelerationProfile?: string;
  textSearchBackend?: string;
  seedQuadCount?: number;
  targetQuadCount?: number;
  fullScale?: boolean;
  iterations?: number;
  warmupIterations?: number;
  concurrency?: number;
  planMatched?: boolean;
  failedPlanCases: string[];
  concurrencyMatched?: boolean;
  failedConcurrencyCases: string[];
  servingRegressionMatched?: boolean;
  servingRegressionThresholdsConfigured?: boolean;
  failedServingRegressionCases: string[];
  fusionBenchmarkMatched?: boolean;
  fusionBenchmarkThresholdsConfigured?: boolean;
  failedFusionBenchmarkCases: string[];
  fusionBaselineComparisonMatched?: boolean;
  failedFusionBaselineComparisonCases: string[];
  benchmarkGateConfigSourcesConfigured?: boolean;
  fusionBaselineReportSourceConfigured?: boolean;
  benchmarkGateConfigSourceShapeMismatches: string[];
  fusionBaselineReportSourceBaselineProfileConfigured?: boolean;
  fusionHardFiltersBeforeRankCaseCount?: number;
  fusionBatchedBroadCandidateJoinCaseCount?: number;
  nativeTextFtsCaseCount?: number;
  ingestDurationMs?: number;
  copyRows?: number;
  copyFallbacks?: number;
  refreshDurationMs?: number;
  plannerStatsDurationMs?: number;
  plannerStatsAnalyzedTables: string[];
  coldStartDurationMs?: number;
  firstQueryDurationMs?: number;
  warmP50DurationMs?: number;
  warmP95DurationMs?: number;
  storageFactsBytes?: number;
  storageDerivedBytes?: number;
  storageTotalBytes?: number;
  storageTotalToFactsRatio?: number;
  pgAccelerationEnabled?: boolean;
  pgAccelerationFallbackReason?: string;
  pgActiveOperators: string[];
}

export class RdfBenchmarkReportCatalog {
  private readonly roots: string[];
  private readonly packageRoot: string;
  private readonly maxReports: number;
  private readonly maxDepth: number;
  private readonly cacheTtlMs: number;
  private cachedSnapshot?: {
    capturedAt: number;
    snapshot: RdfBenchmarkReportCatalogSnapshot;
  };

  public constructor(options: RdfBenchmarkReportCatalogOptions = {}) {
    this.packageRoot = options.packageRoot ?? PACKAGE_ROOT;
    this.roots = options.roots ?? [path.join(this.packageRoot, '.test-data')];
    this.maxReports = options.maxReports ?? DEFAULT_MAX_REPORTS;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  public async snapshot(): Promise<RdfBenchmarkReportCatalogSnapshot> {
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cachedSnapshot.capturedAt < this.cacheTtlMs) {
      return this.cachedSnapshot.snapshot;
    }

    const errors: RdfBenchmarkReportCatalogError[] = [];
    const files: string[] = [];
    let skippedFiles = 0;

    for (const root of this.roots) {
      const normalizedRoot = path.resolve(root);
      try {
        const found = await this.findReportFiles(normalizedRoot, normalizedRoot, 0);
        files.push(...found);
      } catch (error) {
        errors.push({ path: this.displayPath(normalizedRoot), message: errorMessage(error) });
      }
    }

    const reports: RdfBenchmarkReportSummary[] = [];
    const candidates = await this.sortNewestFirst(files, errors);
    for (const file of candidates) {
      if (reports.length >= this.maxReports) {
        skippedFiles += 1;
        continue;
      }
      const parsed = await this.readReport(file);
      if (parsed.ok) {
        reports.push(parsed.report);
      } else {
        skippedFiles += 1;
        errors.push({ path: this.displayPath(file), message: parsed.error });
      }
    }

    const snapshot = {
      roots: this.roots.map((root) => this.displayPath(path.resolve(root))),
      reportCount: reports.length,
      skippedFiles,
      errors,
      reports,
    };
    this.cachedSnapshot = { capturedAt: now, snapshot };
    return snapshot;
  }

  private async findReportFiles(root: string, current: string, depth: number): Promise<string[]> {
    const entries = await readdir(current, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isFile() && isBenchmarkReportFile(entry.name)) {
        files.push(entryPath);
        continue;
      }
      if (!entry.isDirectory() || depth >= this.maxDepth) {
        continue;
      }
      if (depth === 0 && isTestDataRoot(root) && !isRdfBenchmarkDirectory(entry.name)) {
        continue;
      }
      files.push(...await this.findReportFiles(root, entryPath, depth + 1));
    }
    return files;
  }

  private async sortNewestFirst(files: string[], errors: RdfBenchmarkReportCatalogError[]): Promise<string[]> {
    const entries: Array<{ file: string; mtimeMs: number }> = [];
    for (const file of files) {
      try {
        entries.push({ file, mtimeMs: (await stat(file)).mtimeMs });
      } catch (error) {
        errors.push({ path: this.displayPath(file), message: errorMessage(error) });
      }
    }
    return entries
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map((entry) => entry.file);
  }

  private async readReport(file: string): Promise<
    | { ok: true; report: RdfBenchmarkReportSummary }
    | { ok: false; error: string }
  > {
    try {
      const info = await stat(file);
      if (info.size > MAX_REPORT_BYTES) {
        return { ok: false, error: `Report exceeds ${MAX_REPORT_BYTES} bytes` };
      }
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const report = summarizeBenchmarkReport(parsed, this.displayPath(file));
      if (!report) {
        return { ok: false, error: 'Unsupported RDF benchmark report shape' };
      }
      return { ok: true, report };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private displayPath(file: string): string {
    const relative = path.relative(this.packageRoot, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
  }
}

function summarizeBenchmarkReport(input: unknown, reportPath: string): RdfBenchmarkReportSummary | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const seed = recordValue(input.seed);
  const report = recordValue(input.report) ?? input;
  if (!isRecord(report)) {
    return undefined;
  }

  const generatedAt = stringValue(report.generatedAt) ?? timestampFromReportPath(reportPath);
  const engine = stringValue(report.engine);
  if (!engine || !generatedAt) {
    return undefined;
  }

  const storage = recordValue(report.storage);
  const pgAcceleration = recordValue(storage?.pgAcceleration);
  const refresh = recordValue(report.refreshBenchmark) ?? recordValue(report.refresh);
  const rdf3xRefresh = recordValue(recordValue(report.refresh)?.rdf3x);
  const plannerStats = recordValue(rdf3xRefresh?.plannerStats);
  const coldStart = recordValue(report.coldStartBenchmark);
  const startup = recordValue(coldStart?.startup);
  const firstQuery = recordValue(coldStart?.firstQueryAfterRefresh);
  const warmSteadyState = recordValue(coldStart?.warmSteadyState);
  const concurrencyGate = recordValue(report.concurrencyGate);
  const servingRegressionGate = recordValue(report.servingRegressionGate);
  const fusionBenchmarkGate = recordValue(report.fusionBenchmarkGate);
  const failedFusionBaselineComparisonCases = failedBaselineComparisonCases(fusionBenchmarkGate);
  const benchmarkGateConfigSources = recordArrayValue(seed?.benchmarkGateConfigSources);
  const driver = stringValue(seed?.driver);
  const scale = stringValue(report.scale) ?? stringValue(seed?.scale);
  const caseProfile = stringValue(report.caseProfile) ?? stringValue(seed?.caseProfile);
  const targetQuadCount = numberValue(seed?.targetQuadCount);
  const bulkLoad = recordValue(seed?.bulkLoad);
  const copyFromRows = recordValue(bulkLoad?.copyFromRows);

  return {
    id: path.basename(reportPath, '.json'),
    path: reportPath,
    generatedAt,
    engine,
    driver,
    scale,
    caseProfile,
    rdfAccelerationProfile: stringValue(seed?.rdfAccelerationProfile) ?? stringValue(pgAcceleration?.profile),
    textSearchBackend: stringValue(seed?.textSearchBackend),
    seedQuadCount: numberValue(seed?.seedQuadCount),
    targetQuadCount,
    fullScale: booleanValue(seed?.fullScale),
    iterations: numberValue(report.iterations) ?? numberValue(seed?.iterations),
    warmupIterations: numberValue(report.warmupIterations) ?? numberValue(seed?.warmupIterations),
    concurrency: numberValue(report.concurrency) ?? numberValue(seed?.concurrency),
    planMatched: booleanValue(report.planMatched),
    failedPlanCases: stringArrayValue(report.failedPlanCases),
    concurrencyMatched: booleanValue(concurrencyGate?.matched),
    failedConcurrencyCases: stringArrayValue(concurrencyGate?.failedCases),
    servingRegressionMatched: booleanValue(servingRegressionGate?.matched),
    servingRegressionThresholdsConfigured: hasThresholds(servingRegressionGate),
    failedServingRegressionCases: stringArrayValue(servingRegressionGate?.failedCases),
    fusionBenchmarkMatched: booleanValue(fusionBenchmarkGate?.matched),
    fusionBenchmarkThresholdsConfigured: hasThresholds(fusionBenchmarkGate),
    failedFusionBenchmarkCases: stringArrayValue(fusionBenchmarkGate?.failedCases),
    fusionBaselineComparisonMatched: baselineComparisonMatched(fusionBenchmarkGate, failedFusionBaselineComparisonCases),
    failedFusionBaselineComparisonCases,
    benchmarkGateConfigSourcesConfigured: benchmarkGateConfigSources.length > 0,
    fusionBaselineReportSourceConfigured: hasFusionBaselineReportSource(benchmarkGateConfigSources),
    benchmarkGateConfigSourceShapeMismatches: benchmarkGateConfigSourceShapeMismatches(benchmarkGateConfigSources, {
      driver,
      scale,
      targetQuads: targetQuadCount,
      caseProfile,
      textSearchBackend: stringValue(seed?.textSearchBackend),
    }),
    fusionBaselineReportSourceBaselineProfileConfigured: hasFusionBaselineReportSourceBaselineProfile(benchmarkGateConfigSources),
    fusionHardFiltersBeforeRankCaseCount: countFusionCases(fusionBenchmarkGate, 'hardFiltersBeforeRank'),
    fusionBatchedBroadCandidateJoinCaseCount: countFusionCases(fusionBenchmarkGate, 'batchedBroadCandidateJoin'),
    nativeTextFtsCaseCount: countQueryCasesWithPlan(report, 'PostgresNativeFts('),
    ingestDurationMs: numberValue(seed?.ingestDurationMs),
    copyRows: numberValue(copyFromRows?.rows),
    copyFallbacks: numberValue(copyFromRows?.fallbacks),
    refreshDurationMs: numberValue(refresh?.durationMs),
    plannerStatsDurationMs: numberValue(refresh?.plannerStatsDurationMs),
    plannerStatsAnalyzedTables: stringArrayValue(plannerStats?.analyzedTables),
    coldStartDurationMs: numberValue(startup?.durationMs),
    firstQueryDurationMs: numberValue(firstQuery?.durationMs),
    warmP50DurationMs: numberValue(warmSteadyState?.p50DurationMs),
    warmP95DurationMs: numberValue(warmSteadyState?.p95DurationMs),
    storageFactsBytes: numberValue(storage?.factsBytes),
    storageDerivedBytes: numberValue(storage?.derivedBytes),
    storageTotalBytes: numberValue(storage?.totalBytes),
    storageTotalToFactsRatio: numberValue(storage?.totalToFactsRatio),
    pgAccelerationEnabled: booleanValue(pgAcceleration?.enabled),
    pgAccelerationFallbackReason: stringValue(pgAcceleration?.fallbackReason),
    pgActiveOperators: stringArrayValue(pgAcceleration?.activeOperators),
  };
}

function isBenchmarkReportFile(name: string): boolean {
  return /^models-(postgres|rdf3x-shadow|baseline|shadow)-.+\.json$/.test(name);
}

function isTestDataRoot(root: string): boolean {
  return path.basename(root) === '.test-data';
}

function isRdfBenchmarkDirectory(name: string): boolean {
  return name === 'rdf-engine' || name.startsWith('rdf-');
}

function timestampFromReportPath(reportPath: string): string | undefined {
  const match = reportPath.match(/models-[^-]+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function recordArrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function failedBaselineComparisonCases(fusionBenchmarkGate: Record<string, unknown> | undefined): string[] {
  if (!fusionBenchmarkGate) {
    return [];
  }
  const failedCases: string[] = [];
  for (const item of recordArrayValue(fusionBenchmarkGate.cases)) {
    const baselineComparison = recordValue(item.baselineComparison);
    if (!baselineComparison) {
      continue;
    }
    if (booleanValue(baselineComparison.matched) !== true) {
      failedCases.push(stringValue(item.name) ?? 'unnamed fusion case');
    }
  }
  return failedCases;
}

function hasFusionBaselineReportSource(sources: readonly Record<string, unknown>[]): boolean {
  return sources.some((source) => source.kind === 'report-config' || source.kind === 'baseline-report');
}

function hasFusionBaselineReportSourceBaselineProfile(sources: readonly Record<string, unknown>[]): boolean {
  return sources.some((source) => {
    if (source.kind !== 'report-config' && source.kind !== 'baseline-report') {
      return false;
    }
    return stringValue(recordValue(source.seed)?.rdfAccelerationProfile) === 'baseline';
  });
}

function countFusionCases(gate: Record<string, unknown> | undefined, field: string): number {
  return recordArrayValue(gate?.cases).filter((testCase) => booleanValue(testCase[field]) === true).length;
}

function countQueryCasesWithPlan(report: Record<string, unknown>, marker: string): number {
  return recordArrayValue(report.queryCases).filter((testCase) => (
    stringArrayValue(testCase.physicalPlan).some((entry) => entry.includes(marker))
  )).length;
}

function benchmarkGateConfigSourceShapeMismatches(
  sources: readonly Record<string, unknown>[],
  expected: {
    driver?: string;
    scale?: string;
    targetQuads?: number;
    caseProfile?: string;
    textSearchBackend?: string;
  },
): string[] {
  const mismatches: string[] = [];
  sources.forEach((source, index) => {
    const seed = recordValue(source.seed);
    if (!seed) {
      if (source.kind === 'report-config' || source.kind === 'baseline-report') {
        mismatches.push(`source[${index}].seed is missing`);
      }
      return;
    }
    const prefix = `source[${index}]`;
    appendShapeMismatch(mismatches, `${prefix}.driver`, expected.driver, stringValue(seed.driver));
    appendShapeMismatch(mismatches, `${prefix}.scale`, expected.scale, stringValue(seed.scale));
    appendShapeMismatch(mismatches, `${prefix}.targetQuads`, expected.targetQuads, numberValue(seed.targetQuads));
    appendShapeMismatch(mismatches, `${prefix}.caseProfile`, expected.caseProfile, stringValue(seed.caseProfile));
    appendShapeMismatch(mismatches, `${prefix}.textSearchBackend`, expected.textSearchBackend, stringValue(seed.textSearchBackend));
  });
  return mismatches;
}

function appendShapeMismatch<T extends string | number>(
  mismatches: string[],
  label: string,
  expected: T | undefined,
  actual: T | undefined,
): void {
  if (expected !== undefined && actual !== undefined && expected !== actual) {
    mismatches.push(`${label} expected ${expected}, got ${actual}`);
  }
}

function hasThresholds(gate: Record<string, unknown> | undefined): boolean {
  const thresholds = recordValue(gate?.thresholds);
  return numberValue(thresholds?.maxScannedRows) !== undefined
    || numberValue(thresholds?.maxP95DurationMs) !== undefined
    || Object.keys(recordValue(thresholds?.cases) ?? {}).length > 0;
}

function baselineComparisonMatched(
  fusionBenchmarkGate: Record<string, unknown> | undefined,
  failedCases: string[],
): boolean | undefined {
  if (!fusionBenchmarkGate) {
    return undefined;
  }
  const hasBaselineComparison = recordArrayValue(fusionBenchmarkGate.cases)
    .some((item) => Boolean(recordValue(item.baselineComparison)));
  return hasBaselineComparison ? failedCases.length === 0 : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
