import * as path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { PACKAGE_ROOT } from '../../runtime';

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
  ingestDurationMs?: number;
  copyRows?: number;
  copyFallbacks?: number;
  refreshDurationMs?: number;
  plannerStatsDurationMs?: number;
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
  const coldStart = recordValue(report.coldStartBenchmark);
  const startup = recordValue(coldStart?.startup);
  const firstQuery = recordValue(coldStart?.firstQueryAfterRefresh);
  const warmSteadyState = recordValue(coldStart?.warmSteadyState);
  const concurrencyGate = recordValue(report.concurrencyGate);
  const bulkLoad = recordValue(seed?.bulkLoad);
  const copyFromRows = recordValue(bulkLoad?.copyFromRows);

  return {
    id: path.basename(reportPath, '.json'),
    path: reportPath,
    generatedAt,
    engine,
    driver: stringValue(seed?.driver),
    scale: stringValue(report.scale) ?? stringValue(seed?.scale),
    caseProfile: stringValue(report.caseProfile) ?? stringValue(seed?.caseProfile),
    rdfAccelerationProfile: stringValue(seed?.rdfAccelerationProfile) ?? stringValue(pgAcceleration?.profile),
    seedQuadCount: numberValue(seed?.seedQuadCount),
    targetQuadCount: numberValue(seed?.targetQuadCount),
    fullScale: booleanValue(seed?.fullScale),
    iterations: numberValue(report.iterations) ?? numberValue(seed?.iterations),
    warmupIterations: numberValue(report.warmupIterations) ?? numberValue(seed?.warmupIterations),
    concurrency: numberValue(report.concurrency) ?? numberValue(seed?.concurrency),
    planMatched: booleanValue(report.planMatched),
    failedPlanCases: stringArrayValue(report.failedPlanCases),
    concurrencyMatched: booleanValue(concurrencyGate?.matched),
    failedConcurrencyCases: stringArrayValue(concurrencyGate?.failedCases),
    ingestDurationMs: numberValue(seed?.ingestDurationMs),
    copyRows: numberValue(copyFromRows?.rows),
    copyFallbacks: numberValue(copyFromRows?.fallbacks),
    refreshDurationMs: numberValue(refresh?.durationMs),
    plannerStatsDurationMs: numberValue(refresh?.plannerStatsDurationMs),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
