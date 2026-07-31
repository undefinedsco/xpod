/**
 * Admin API - 管理接口
 */

export interface ServiceState {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'crashed';
  pid?: number;
  uptime?: number;
  restartCount: number;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
}

export interface AdminStatus {
  status: string;
  pid: number;
  ppid: number;
  uptime: number;
  env: {
    CSS_BASE_URL?: string;
    XPOD_EDITION?: string;
    CSS_PORT?: string;
  };
  configs: Array<{
    name: string;
    path: string;
    exists: boolean;
  }>;
  capabilities?: AdminCapabilities;
}

export interface AdminCapability {
  supported: boolean;
  reason?: string;
}

export interface AdminCapabilities {
  services?: {
    lifecycle?: {
      restart?: AdminCapability;
    };
    configuration?: {
      write?: AdminCapability;
    };
  };
}

export interface AdminConfig {
  env: Record<string, string>;
  secrets?: Record<string, { configured: boolean }>;
  configFiles: Array<{
    name: string;
    path: string;
    exists: boolean;
  }>;
}

export interface PublicIpCheckResult {
  status: 'pass' | 'fail' | 'unknown';
  publicIp: string | null;
  ipv4?: string | null;
  baseUrl: string;
  detail: string;
}

const API_BASE = '/api/admin';

export interface AdminFetchOptions {
  signal?: AbortSignal;
}

export type RdfStatsSnapshot =
  | {
      available: true;
      engine: 'postgres-rdf';
      generatedAt: string;
      stats: RdfStorageStats;
      benchmarkReports?: RdfBenchmarkReportCatalogSnapshot;
    }
  | {
      available: false;
      engine: 'postgres-rdf' | 'unsupported';
      generatedAt: string;
      reason: 'not-cloud' | 'missing-sparql-endpoint' | 'unsupported-sparql-endpoint';
      benchmarkReports?: RdfBenchmarkReportCatalogSnapshot;
    };

export interface RdfBenchmarkReportCatalogSnapshot {
  roots: string[];
  reportCount: number;
  skippedFiles: number;
  errors: Array<{
    path: string;
    message: string;
  }>;
  reports: RdfBenchmarkReportSummary[];
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
  plannerStatsAnalyzedTables?: string[];
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

export interface RdfStorageStats {
  factsBytes: number;
  derivedBytes: number;
  totalBytes: number;
  totalToFactsRatio: number;
  derivedToFactsRatio: number;
  lifecycle?: {
    status: 'closed' | 'opening' | 'ready' | 'failed';
    driver?: string;
    openCount: number;
    lastOpenStartedAt?: string;
    lastReadyAt?: string;
    lastOpenDurationMs?: number;
    lastOpenFailedAt?: string;
    lastOpenError?: string;
    coldStart?: {
      startedAt: string;
      readyAt: string;
      durationMs: number;
      phases: Array<{
        name: string;
        durationMs: number;
      }>;
      customIndexDeferred: boolean;
      maintenanceEnabled: boolean;
      ownsTextIndex: boolean;
      ownsVectorIndex: boolean;
    };
  };
  rdf3x?: {
    factsDataVersion: number;
    rdf3xFactsDataVersion: number;
    refreshLag: number;
    syncedWithFacts: boolean;
    pendingSources: number;
  };
  derivedCache?: {
    cacheBytes: number;
    maxCacheBytes: number;
    cachePressure: number;
    maxScopeBytes: number;
    scopeVersionCount: number;
    scopeEntries: RdfDerivedCacheScopeEntry[];
    largestScopeBytes: number;
    largestScopePressure: number;
    largestScopeHash?: string;
    largestScopeFactsDataVersion?: number;
    evictionCount: number;
    evictions: RdfDerivedCacheEvictionStats;
    queryResultPayloadBytes: number;
    materializedResultPayloadBytes: number;
    queryTemplateBytes: number;
  };
  queryResultCache?: RdfCacheStats;
  materializedResultCache?: RdfCacheStats;
  queryTemplateCache?: {
    entryCount: number;
    maxEntries: number;
    hitCount: number;
    missCount: number;
    evictionCount: number;
    totalBytes: number;
  };
  slowQueries?: {
    entryCount: number;
    maxEntries: number;
    entries: RdfSlowQueryEntry[];
  };
  pgAcceleration?: {
    profile: string;
    requested: boolean;
    available: boolean;
    enabled: boolean;
    provider?: string;
    version?: string;
    capabilities: string[];
    capabilityProviders?: Record<string, string>;
    requiredCapabilities: string[];
    fallbackReason?: string;
    fallbackDetail?: string;
    activeOperators?: string[];
    missingCapabilities?: string[];
    customIndexes?: Array<{
      name: string;
      permutation: string;
      columns: string[];
      stats?: Record<string, unknown>;
      error?: string;
    }>;
  };
}

export interface RdfStatsOptions {
  cacheScopeQuery?: string;
  cacheScopePrincipal?: string;
  cacheScopeBasePath?: string;
  cacheScopeMode?: string;
  cacheScopeAuthorizationModel?: string;
  cacheScopePermissionVersion?: string;
  cacheScopeLimit?: number;
}

export interface RdfDerivedCacheScopeEntry {
  scopeHash: string;
  factsDataVersion: number;
  payloadBytes: number;
  queryResultPayloadBytes: number;
  materializedResultPayloadBytes: number;
  queryResultEntries: number;
  materializedResultEntries: number;
  scopeShape?: string;
  principal?: string;
  basePath?: string;
  mode?: string;
  authorizationModel?: string;
  permissionVersion?: string;
}

export interface RdfDerivedCacheEvictionStats {
  factsVersion: number;
  ttl: number;
  maxEntries: number;
  payloadBytes: number;
  scopeBytes: number;
  totalBytes: number;
  templateTtl: number;
  templateMaxEntries: number;
  templateBytes: number;
}

export interface RdfCacheStats {
  entryCount: number;
  scopeCount: number;
  maxEntries: number;
  ttlMs: number;
  hitCount: number;
  missCount: number;
  refreshCount: number;
  storeCount: number;
  bypassCount: number;
  disabledCount: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
}

export interface RdfSlowQueryEntry {
  generatedAt: string;
  queryKey: string;
  templateKey?: string;
  selectedPath: string;
  reasons: string[];
  runtime: {
    durationMs: number;
    scannedRows: number;
    joinedRows: number;
    returnedRows: number;
    filtersApplied: number;
    filtersPushedDown: number;
    indexChoices: string[];
    planSize: number;
  };
  slowQuery: {
    durationMs: number;
    thresholdMs: number;
    scannedRows: number;
    scannedRowsThreshold: number;
    scanAmplification: number;
    reasons: string[];
  };
  staleStats?: {
    factsDataVersion: number;
    rdf3xFactsDataVersion: number;
    stale: boolean;
    lag: number;
  };
  histogramHints?: RdfPlannerHistogramHint[];
  rejectedNativeOperators?: RdfPlannerNativeOperatorRejection[];
  derivedCache: RdfSlowQueryDerivedCache;
  cache: {
    templateStatus?: string;
    resultStatus?: string;
    materializedStatus?: string;
    result?: RdfSlowQueryCacheExplain;
    materialized?: RdfSlowQueryCacheExplain;
    scopeHash: string;
    scopeBasePath: string | null;
    scopePrincipal: string | null;
  };
  acceleration: {
    profile: string;
    requested: boolean;
    enabled: boolean;
    provider?: string;
    fallbackReason?: string;
    activeOperators?: string[];
    unsupportedCapabilities?: string[];
  };
}

export interface RdfPlannerCardinalityTerm {
  value: string;
  kind: string;
  datatype?: string;
  language?: string;
}

export interface RdfPlannerHistogramHint {
  kind: 'graph' | 'predicate' | 'predicate-object' | 'subject-predicate';
  patternIndex: number;
  quadCount: number;
  graphCount?: number;
  distinctSubjects?: number;
  distinctPredicates?: number;
  distinctObjects?: number;
  subject?: RdfPlannerCardinalityTerm;
  predicate?: RdfPlannerCardinalityTerm;
  object?: RdfPlannerCardinalityTerm;
  graph?: RdfPlannerCardinalityTerm;
}

export interface RdfPlannerNativeOperatorRejection {
  capability: string;
  reason: string;
}

export interface RdfSlowQueryDerivedCache {
  cacheBytes: number;
  maxCacheBytes: number;
  cachePressure: number;
  largestScopeBytes: number;
  largestScopePressure: number;
  largestScopeHash?: string;
  largestScopeFactsDataVersion?: number;
  evictionCount: number;
  evictions: RdfDerivedCacheEvictionStats;
}

export interface RdfSlowQueryCacheExplain {
  status: string;
  key?: string;
  templateKey?: string;
  factsDataVersion?: number;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  stored?: boolean;
}

/**
 * 获取 xpod 状态
 */
export async function getAdminStatus(options: AdminFetchOptions = {}): Promise<AdminStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/status`, { signal: options.signal });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get admin status:', e);
  }
  return null;
}

/**
 * 获取配置
 */
export async function getAdminConfig(options: AdminFetchOptions = {}): Promise<AdminConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/config`, { signal: options.signal });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get admin config:', e);
  }
  return null;
}

export async function getPublicIpCheck(baseUrl?: string, options: AdminFetchOptions = {}): Promise<PublicIpCheckResult | null> {
  try {
    const qs = baseUrl ? '?baseUrl=' + encodeURIComponent(baseUrl) : '';
    const res = await fetch(API_BASE + '/public-ip' + qs, { signal: options.signal });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get public ip check:', e);
  }
  return null;
}

/**
 * 更新配置
 */
export async function updateAdminConfig(env: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env }),
    });
    return res.ok;
  } catch (e) {
    console.error('Failed to update admin config:', e);
    return false;
  }
}

/**
 * 触发重启
 */
export async function triggerRestart(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/restart`, {
      method: 'POST',
    });
    return res.ok;
  } catch (e) {
    console.error('Failed to trigger restart:', e);
    return false;
  }
}

/**
 * 获取 Gateway 状态（子进程状态）
 */
export async function getGatewayStatus(options: AdminFetchOptions = {}): Promise<ServiceState[] | null> {
  try {
    const res = await fetch('/service/status', { signal: options.signal });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get gateway status:', e);
  }
  return null;
}

export async function getRdfStats(options: RdfStatsOptions = {}): Promise<RdfStatsSnapshot | null> {
  try {
    const params = rdfStatsSearchParams(options);
    const query = params.toString();
    const res = await fetch(`${API_BASE}/rdf/stats${query ? `?${query}` : ''}`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get RDF stats:', e);
  }
  return null;
}

function rdfStatsSearchParams(options: RdfStatsOptions): URLSearchParams {
  const params = new URLSearchParams();
  appendParam(params, 'cacheScopeQuery', options.cacheScopeQuery);
  appendParam(params, 'cacheScopePrincipal', options.cacheScopePrincipal);
  appendParam(params, 'cacheScopeBasePath', options.cacheScopeBasePath);
  appendParam(params, 'cacheScopeMode', options.cacheScopeMode);
  appendParam(params, 'cacheScopeAuthorizationModel', options.cacheScopeAuthorizationModel);
  appendParam(params, 'cacheScopePermissionVersion', options.cacheScopePermissionVersion);
  appendParam(params, 'cacheScopeLimit', options.cacheScopeLimit);
  return params;
}

function appendParam(params: URLSearchParams, name: string, value: string | number | undefined): void {
  if (value !== undefined && value !== '') {
    params.set(name, String(value));
  }
}

/**
 * 获取日志 (从 Gateway/Supervisor)
 */
export async function getLogs(options?: {
  limit?: number;
  level?: string;
  source?: string;
}): Promise<LogEntry[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.level && options.level !== 'all') params.set('level', options.level);
    if (options?.source && options.source !== 'all') params.set('source', options.source);

    const qs = params.toString();
    const res = await fetch(`${API_BASE}/logs${qs ? `?${qs}` : ''}`);
    if (res.ok) {
      const body = await res.json();
      return Array.isArray(body) ? body : body.logs ?? [];
    }
  } catch (e) {
    console.error('Failed to get logs:', e);
  }
  return [];
}

export async function getLogFileTail(options?: {
  lines?: number;
}): Promise<{ file: string; lines: string[] } | null> {
  try {
    const params = new URLSearchParams();
    if (options?.lines) params.set('lines', options.lines.toString());
    const qs = params.toString();
    const res = await fetch(`${API_BASE}/logs/file${qs ? `?${qs}` : ''}`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get log file tail:', e);
  }
  return null;
}

export async function buildDiagnosticsSnapshot(): Promise<Record<string, unknown>> {
  const [gatewayStatus, adminStatus, config, ddnsStatus, logs, logFile] = await Promise.all([
    getGatewayStatus(),
    getAdminStatus(),
    getAdminConfig(),
    getDdnsStatus(),
    getLogs({ limit: 200 }),
    getLogFileTail({ lines: 120 }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    gatewayStatus,
    adminStatus,
    sanitizedConfig: {
      env: config?.env ?? {},
      secrets: config?.secrets ?? {},
    },
    ddnsStatus,
    recentLogs: logs,
    logFile,
  };
}

/**
 * 订阅实时日志 (SSE)
 */
export function subscribeLogs(
  onLog: (logs: LogEntry[]) => void,
  onError?: (error: Event) => void
): () => void {
  const eventSource = new EventSource(`${API_BASE}/logs/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.logs) {
        onLog(data.logs);
      }
    } catch (e) {
      console.error('Failed to parse log data:', e);
    }
  };

  eventSource.onerror = (error) => {
    console.error('Log stream error:', error);
    onError?.(error);
  };

  // Return unsubscribe function
  return () => {
    eventSource.close();
  };
}


export interface DdnsStatus {
  enabled: boolean;
  allocated: boolean;
  fqdn: string | null;
  baseUrl: string;
  mode: 'direct' | 'tunnel' | 'unknown';
  tunnelProvider: string;
  ipv4: string | null;
  ipv6: string | null;
  detail: string;
}

function fqdnToHttpsUrl(fqdn: string | null | undefined): string {
  if (!fqdn) return '';
  return fqdn.startsWith('http://') || fqdn.startsWith('https://') ? fqdn : `https://${fqdn}/`;
}

export function resolveAdminAccessBaseUrl(
  env: Record<string, string>,
  ddnsData: DdnsStatus | null,
  fallback = '',
): string {
  return ddnsData?.baseUrl || fqdnToHttpsUrl(ddnsData?.fqdn) || env.CSS_BASE_URL || fallback;
}

export async function getDdnsStatus(options: AdminFetchOptions = {}): Promise<DdnsStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/ddns`, { signal: options.signal });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get ddns status:', e);
  }
  return null;
}

export interface ServicesStatusSnapshot {
  servicesData: ServiceState[] | null;
  adminData: AdminStatus | null;
  configData: AdminConfig | null;
  ddnsData: DdnsStatus | null;
  publicCheck: PublicIpCheckResult | null;
  checkedAt: Date;
}

export async function fetchServicesStatusSnapshot(options: AdminFetchOptions = {}): Promise<ServicesStatusSnapshot> {
  const [servicesData, adminData, configData, ddnsData] = await Promise.all([
    getGatewayStatus(options),
    getAdminStatus(options),
    getAdminConfig(options),
    getDdnsStatus(options),
  ]);
  const publicCheck = await getPublicIpCheck(resolveAdminAccessBaseUrl(configData?.env ?? {}, ddnsData), options);

  return {
    servicesData,
    adminData,
    configData,
    ddnsData,
    publicCheck,
    checkedAt: new Date(),
  };
}

export async function refreshDdnsStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/ddns/refresh`, { method: 'POST' });
    return res.ok;
  } catch (e) {
    console.error('Failed to refresh ddns status:', e);
    return false;
  }
}
