import type {
  RdfBenchmarkReportCatalogSnapshot,
  RdfBenchmarkReportSummary,
} from './RdfBenchmarkReportCatalog';

export interface RdfBenchmarkReportGateOptions {
  requiredScale?: string;
  requiredDriver?: string;
  requiredRdfAccelerationProfile?: string;
  minTargetQuadCount?: number;
  minSeedQuadCount?: number;
  minConcurrency?: number;
  requireFullScale?: boolean;
  requireCopyIngest?: boolean;
  allowCopyFallbacks?: boolean;
  requirePlannerStats?: boolean;
  requireColdWarmTimings?: boolean;
  requireStorageRatio?: boolean;
}

export interface RdfBenchmarkReportGateResult {
  matched: boolean;
  evaluatedAt: string;
  checkedReportCount: number;
  required: RequiredRdfBenchmarkReportGateOptions;
  matchedReport?: RdfBenchmarkReportSummary;
  failedReasons: string[];
  candidates: RdfBenchmarkReportGateCandidate[];
}

export interface RdfBenchmarkReportGateCandidate {
  id: string;
  path: string;
  generatedAt: string;
  matched: boolean;
  failedReasons: string[];
}

export interface RequiredRdfBenchmarkReportGateOptions {
  requiredScale: string;
  requiredDriver: string;
  requiredRdfAccelerationProfile?: string;
  minTargetQuadCount: number;
  minSeedQuadCount: number;
  minConcurrency: number;
  requireFullScale: boolean;
  requireCopyIngest: boolean;
  allowCopyFallbacks: boolean;
  requirePlannerStats: boolean;
  requireColdWarmTimings: boolean;
  requireStorageRatio: boolean;
}

const DEFAULT_MIN_TARGET_QUADS = 1_000_000;
const DEFAULT_MIN_CONCURRENCY = 4;

export function evaluateRdfBenchmarkReportGate(
  snapshot: RdfBenchmarkReportCatalogSnapshot,
  options: RdfBenchmarkReportGateOptions = {},
): RdfBenchmarkReportGateResult {
  const required = normalizeGateOptions(options);
  const candidates = snapshot.reports.map((report) => evaluateCandidate(report, required));
  const matched = candidates.find((candidate) => candidate.matched);
  const matchedReport = matched
    ? snapshot.reports.find((report) => report.path === matched.path)
    : undefined;

  return {
    matched: Boolean(matched),
    evaluatedAt: new Date().toISOString(),
    checkedReportCount: snapshot.reports.length,
    required,
    matchedReport,
    failedReasons: matched ? [] : topLevelFailedReasons(snapshot, candidates),
    candidates,
  };
}

function normalizeGateOptions(options: RdfBenchmarkReportGateOptions): RequiredRdfBenchmarkReportGateOptions {
  const minTargetQuadCount = positiveOrDefault(options.minTargetQuadCount, DEFAULT_MIN_TARGET_QUADS);
  return {
    requiredScale: options.requiredScale ?? 'large',
    requiredDriver: options.requiredDriver ?? 'pg',
    requiredRdfAccelerationProfile: options.requiredRdfAccelerationProfile,
    minTargetQuadCount,
    minSeedQuadCount: positiveOrDefault(options.minSeedQuadCount, minTargetQuadCount),
    minConcurrency: positiveOrDefault(options.minConcurrency, DEFAULT_MIN_CONCURRENCY),
    requireFullScale: options.requireFullScale ?? true,
    requireCopyIngest: options.requireCopyIngest ?? true,
    allowCopyFallbacks: options.allowCopyFallbacks ?? false,
    requirePlannerStats: options.requirePlannerStats ?? true,
    requireColdWarmTimings: options.requireColdWarmTimings ?? true,
    requireStorageRatio: options.requireStorageRatio ?? true,
  };
}

function evaluateCandidate(
  report: RdfBenchmarkReportSummary,
  required: RequiredRdfBenchmarkReportGateOptions,
): RdfBenchmarkReportGateCandidate {
  const failedReasons: string[] = [];
  requireEqual(failedReasons, 'scale', report.scale, required.requiredScale);
  requireEqual(failedReasons, 'driver', report.driver, required.requiredDriver);
  if (required.requiredRdfAccelerationProfile) {
    requireEqual(
      failedReasons,
      'rdfAccelerationProfile',
      report.rdfAccelerationProfile,
      required.requiredRdfAccelerationProfile,
    );
  }
  requireAtLeast(failedReasons, 'targetQuadCount', report.targetQuadCount, required.minTargetQuadCount);
  requireAtLeast(failedReasons, 'seedQuadCount', report.seedQuadCount, required.minSeedQuadCount);
  if (required.requireFullScale && report.fullScale !== true) {
    failedReasons.push(`fullScale expected true, got ${String(report.fullScale)}`);
  }
  if (report.planMatched !== true || report.failedPlanCases.length > 0) {
    failedReasons.push(`plan gate failed: ${report.failedPlanCases.join(', ') || 'planMatched is not true'}`);
  }
  requireAtLeast(failedReasons, 'concurrency', report.concurrency, required.minConcurrency);
  if (report.concurrencyMatched !== true || report.failedConcurrencyCases.length > 0) {
    failedReasons.push(`concurrency gate failed: ${report.failedConcurrencyCases.join(', ') || 'concurrencyMatched is not true'}`);
  }
  if (required.requireCopyIngest) {
    requirePositive(failedReasons, 'copyRows', report.copyRows);
    if (!required.allowCopyFallbacks && (report.copyFallbacks ?? 0) > 0) {
      failedReasons.push(`copyFallbacks expected 0, got ${report.copyFallbacks}`);
    }
  }
  if (required.requirePlannerStats) {
    requirePositive(failedReasons, 'refreshDurationMs', report.refreshDurationMs);
    requireNonNegative(failedReasons, 'plannerStatsDurationMs', report.plannerStatsDurationMs);
    if (report.plannerStatsAnalyzedTables.length === 0) {
      failedReasons.push('plannerStatsAnalyzedTables is empty');
    }
  }
  if (required.requireColdWarmTimings) {
    requirePositive(failedReasons, 'coldStartDurationMs', report.coldStartDurationMs);
    requirePositive(failedReasons, 'firstQueryDurationMs', report.firstQueryDurationMs);
    requirePositive(failedReasons, 'warmP50DurationMs', report.warmP50DurationMs);
    requirePositive(failedReasons, 'warmP95DurationMs', report.warmP95DurationMs);
  }
  if (required.requireStorageRatio) {
    requirePositive(failedReasons, 'storageFactsBytes', report.storageFactsBytes);
    requirePositive(failedReasons, 'storageTotalBytes', report.storageTotalBytes);
    requirePositive(failedReasons, 'storageTotalToFactsRatio', report.storageTotalToFactsRatio);
  }

  return {
    id: report.id,
    path: report.path,
    generatedAt: report.generatedAt,
    matched: failedReasons.length === 0,
    failedReasons,
  };
}

function topLevelFailedReasons(
  snapshot: RdfBenchmarkReportCatalogSnapshot,
  candidates: RdfBenchmarkReportGateCandidate[],
): string[] {
  if (snapshot.reports.length === 0) {
    return ['no benchmark reports found'];
  }
  const newest = candidates[0];
  if (!newest) {
    return ['no benchmark reports found'];
  }
  return [
    `no report satisfied the gate; newest report ${newest.path} failed`,
    ...newest.failedReasons,
  ];
}

function requireEqual(
  failedReasons: string[],
  label: string,
  actual: string | undefined,
  expected: string,
): void {
  if (actual !== expected) {
    failedReasons.push(`${label} expected ${expected}, got ${actual ?? 'missing'}`);
  }
}

function requireAtLeast(
  failedReasons: string[],
  label: string,
  actual: number | undefined,
  expected: number,
): void {
  if (!Number.isFinite(actual) || (actual ?? 0) < expected) {
    failedReasons.push(`${label} expected >= ${expected}, got ${actual ?? 'missing'}`);
  }
}

function requirePositive(failedReasons: string[], label: string, actual: number | undefined): void {
  if (!Number.isFinite(actual) || (actual ?? 0) <= 0) {
    failedReasons.push(`${label} expected > 0, got ${actual ?? 'missing'}`);
  }
}

function requireNonNegative(failedReasons: string[], label: string, actual: number | undefined): void {
  if (!Number.isFinite(actual) || (actual ?? -1) < 0) {
    failedReasons.push(`${label} expected >= 0, got ${actual ?? 'missing'}`);
  }
}

function positiveOrDefault(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}
