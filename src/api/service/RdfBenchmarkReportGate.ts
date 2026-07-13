import type {
  RdfBenchmarkReportCatalogSnapshot,
  RdfBenchmarkReportSummary,
} from './RdfBenchmarkReportCatalog';

export interface RdfBenchmarkReportGateOptions {
  requiredScale?: string;
  requiredDriver?: string;
  requiredCaseProfile?: string;
  requiredRdfAccelerationProfile?: string;
  requiredTextSearchBackend?: string;
  minTargetQuadCount?: number;
  minSeedQuadCount?: number;
  minIterations?: number;
  minWarmupIterations?: number;
  minConcurrency?: number;
  requireFullScale?: boolean;
  requireCopyIngest?: boolean;
  allowCopyFallbacks?: boolean;
  requirePlannerStats?: boolean;
  requireColdWarmTimings?: boolean;
  requireStorageRatio?: boolean;
  requireServingRegressionGate?: boolean;
  requireServingRegressionThresholds?: boolean;
  requireFusionBenchmarkGate?: boolean;
  requireFusionBenchmarkThresholds?: boolean;
  requireFusionBaselineComparison?: boolean;
  requireBenchmarkGateConfigSources?: boolean;
  requireFusionBaselineReportSource?: boolean;
  requireFusionBaselineSourceBaselineProfile?: boolean;
  requireFusionHardFilterEvidence?: boolean;
  requireFusionBatchedBroadCandidateJoinEvidence?: boolean;
  requireNativeTextFtsEvidence?: boolean;
  requireNativeVectorEvidence?: boolean;
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
  requiredCaseProfile?: string;
  requiredRdfAccelerationProfile?: string;
  requiredTextSearchBackend?: string;
  minTargetQuadCount: number;
  minSeedQuadCount: number;
  minIterations: number;
  minWarmupIterations: number;
  minConcurrency: number;
  requireFullScale: boolean;
  requireCopyIngest: boolean;
  allowCopyFallbacks: boolean;
  requirePlannerStats: boolean;
  requireColdWarmTimings: boolean;
  requireStorageRatio: boolean;
  requireServingRegressionGate: boolean;
  requireServingRegressionThresholds: boolean;
  requireFusionBenchmarkGate: boolean;
  requireFusionBenchmarkThresholds: boolean;
  requireFusionBaselineComparison: boolean;
  requireBenchmarkGateConfigSources: boolean;
  requireFusionBaselineReportSource: boolean;
  requireFusionBaselineSourceBaselineProfile: boolean;
  requireFusionHardFilterEvidence: boolean;
  requireFusionBatchedBroadCandidateJoinEvidence: boolean;
  requireNativeTextFtsEvidence: boolean;
  requireNativeVectorEvidence: boolean;
}

const DEFAULT_MIN_TARGET_QUADS = 1_000_000;
const DEFAULT_MIN_ITERATIONS = 1;
const DEFAULT_MIN_WARMUP_ITERATIONS = 0;
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
    requiredCaseProfile: options.requiredCaseProfile,
    requiredRdfAccelerationProfile: options.requiredRdfAccelerationProfile,
    requiredTextSearchBackend: options.requiredTextSearchBackend,
    minTargetQuadCount,
    minSeedQuadCount: positiveOrDefault(options.minSeedQuadCount, minTargetQuadCount),
    minIterations: positiveOrDefault(options.minIterations, DEFAULT_MIN_ITERATIONS),
    minWarmupIterations: nonNegativeOrDefault(options.minWarmupIterations, DEFAULT_MIN_WARMUP_ITERATIONS),
    minConcurrency: positiveOrDefault(options.minConcurrency, DEFAULT_MIN_CONCURRENCY),
    requireFullScale: options.requireFullScale ?? true,
    requireCopyIngest: options.requireCopyIngest ?? true,
    allowCopyFallbacks: options.allowCopyFallbacks ?? false,
    requirePlannerStats: options.requirePlannerStats ?? true,
    requireColdWarmTimings: options.requireColdWarmTimings ?? true,
    requireStorageRatio: options.requireStorageRatio ?? true,
    requireServingRegressionGate: options.requireServingRegressionGate ?? false,
    requireServingRegressionThresholds: options.requireServingRegressionThresholds ?? false,
    requireFusionBenchmarkGate: options.requireFusionBenchmarkGate ?? false,
    requireFusionBenchmarkThresholds: options.requireFusionBenchmarkThresholds ?? false,
    requireFusionBaselineComparison: options.requireFusionBaselineComparison ?? false,
    requireBenchmarkGateConfigSources: options.requireBenchmarkGateConfigSources ?? false,
    requireFusionBaselineReportSource: options.requireFusionBaselineReportSource ?? false,
    requireFusionBaselineSourceBaselineProfile: options.requireFusionBaselineSourceBaselineProfile ?? false,
    requireFusionHardFilterEvidence: options.requireFusionHardFilterEvidence ?? false,
    requireFusionBatchedBroadCandidateJoinEvidence: options.requireFusionBatchedBroadCandidateJoinEvidence ?? false,
    requireNativeTextFtsEvidence: options.requireNativeTextFtsEvidence ?? false,
    requireNativeVectorEvidence: options.requireNativeVectorEvidence ?? false,
  };
}

function evaluateCandidate(
  report: RdfBenchmarkReportSummary,
  required: RequiredRdfBenchmarkReportGateOptions,
): RdfBenchmarkReportGateCandidate {
  const failedReasons: string[] = [];
  requireEqual(failedReasons, 'scale', report.scale, required.requiredScale);
  requireEqual(failedReasons, 'driver', report.driver, required.requiredDriver);
  if (required.requiredCaseProfile) {
    requireEqual(failedReasons, 'caseProfile', report.caseProfile, required.requiredCaseProfile);
  }
  if (required.requiredRdfAccelerationProfile) {
    requireEqual(
      failedReasons,
      'rdfAccelerationProfile',
      report.rdfAccelerationProfile,
      required.requiredRdfAccelerationProfile,
    );
  }
  if (required.requiredTextSearchBackend) {
    requireEqual(
      failedReasons,
      'textSearchBackend',
      report.textSearchBackend,
      required.requiredTextSearchBackend,
    );
  }
  requireAtLeast(failedReasons, 'targetQuadCount', report.targetQuadCount, required.minTargetQuadCount);
  requireAtLeast(failedReasons, 'seedQuadCount', report.seedQuadCount, required.minSeedQuadCount);
  requireAtLeast(failedReasons, 'iterations', report.iterations, required.minIterations);
  requireAtLeast(failedReasons, 'warmupIterations', report.warmupIterations, required.minWarmupIterations);
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
  if (required.requireServingRegressionGate && (report.servingRegressionMatched !== true || report.failedServingRegressionCases.length > 0)) {
    failedReasons.push(`serving regression gate failed: ${report.failedServingRegressionCases.join(', ') || 'servingRegressionMatched is not true'}`);
  }
  if (required.requireServingRegressionThresholds && report.servingRegressionThresholdsConfigured !== true) {
    failedReasons.push('serving regression thresholds are not configured');
  }
  if (required.requireFusionBenchmarkGate && (report.fusionBenchmarkMatched !== true || report.failedFusionBenchmarkCases.length > 0)) {
    failedReasons.push(`fusion benchmark gate failed: ${report.failedFusionBenchmarkCases.join(', ') || 'fusionBenchmarkMatched is not true'}`);
  }
  if (required.requireFusionBenchmarkThresholds && report.fusionBenchmarkThresholdsConfigured !== true) {
    failedReasons.push('fusion benchmark thresholds are not configured');
  }
  if (
    required.requireFusionBaselineComparison &&
    (report.fusionBaselineComparisonMatched !== true || report.failedFusionBaselineComparisonCases.length > 0)
  ) {
    failedReasons.push(`fusion baseline comparison gate failed: ${report.failedFusionBaselineComparisonCases.join(', ') || 'fusionBaselineComparisonMatched is not true'}`);
  }
  if (required.requireBenchmarkGateConfigSources && report.benchmarkGateConfigSourcesConfigured !== true) {
    failedReasons.push('benchmark gate config sources are not configured');
  }
  if (required.requireFusionBaselineReportSource && report.fusionBaselineReportSourceConfigured !== true) {
    failedReasons.push('fusion baseline report source is not configured');
  }
  if (
    required.requireFusionBaselineSourceBaselineProfile &&
    report.fusionBaselineReportSourceBaselineProfileConfigured !== true
  ) {
    failedReasons.push('fusion baseline source baseline profile is not configured');
  }
  if (required.requireBenchmarkGateConfigSources && report.benchmarkGateConfigSourceShapeMismatches.length > 0) {
    failedReasons.push(`benchmark gate config source shape mismatch: ${report.benchmarkGateConfigSourceShapeMismatches.join('; ')}`);
  }
  if (required.requireFusionHardFilterEvidence) {
    requirePositive(
      failedReasons,
      'fusion hard-filter-before-rank evidence',
      report.fusionHardFiltersBeforeRankCaseCount,
    );
  }
  if (required.requireFusionBatchedBroadCandidateJoinEvidence) {
    requirePositive(
      failedReasons,
      'fusion batched broad candidate join evidence',
      report.fusionBatchedBroadCandidateJoinCaseCount,
    );
  }
  if (required.requireNativeTextFtsEvidence) {
    requirePositive(failedReasons, 'native text FTS evidence', report.nativeTextFtsCaseCount);
  }
  if (required.requireNativeVectorEvidence) {
    requirePositive(failedReasons, 'native vector evidence', report.nativeVectorCaseCount);
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

function nonNegativeOrDefault(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultValue;
}
