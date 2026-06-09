/**
 * RDF 页面 - 索引与查询观测
 */

import type { ComponentType, FormEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, Database, Gauge, RefreshCw, Search, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import {
  getRdfStats,
  type RdfBenchmarkReportCatalogSnapshot,
  type RdfBenchmarkReportSummary,
  type RdfDerivedCacheEvictionStats,
  type RdfDerivedCacheScopeEntry,
  type RdfSlowQueryEntry,
  type RdfStatsSnapshot,
} from '@/api/admin';

const unavailableReasonText: Record<NonNullable<Extract<RdfStatsSnapshot, { available: false }>['reason']>, string> = {
  'not-cloud': '非 Cloud 模式',
  'missing-sparql-endpoint': '缺少 PostgreSQL 端点',
  'unsupported-sparql-endpoint': '非 PostgreSQL 端点',
};

function rdfStatsOptionsForScopeQuery(query: string) {
  const normalized = query.trim();
  return normalized ? { cacheScopeQuery: normalized, cacheScopeLimit: 50 } : {};
}

export function RdfPage() {
  const [snapshot, setSnapshot] = useState<RdfStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [cacheScopeQuery, setCacheScopeQuery] = useState('');
  const [appliedCacheScopeQuery, setAppliedCacheScopeQuery] = useState('');
  const initialLoadStarted = useRef(false);

  const loadStats = useCallback(async (
    initial = false,
    cacheScopeQueryOverride = appliedCacheScopeQuery,
  ): Promise<void> => {
    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError('');
    try {
      const next = await getRdfStats(rdfStatsOptionsForScopeQuery(cacheScopeQueryOverride));
      if (next) {
        setSnapshot(next);
      } else {
        setError('RDF 统计不可用');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [appliedCacheScopeQuery]);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void loadStats(true);
  }, [loadStats]);

  useEffect(() => {
    const interval = setInterval(() => void loadStats(false), 10_000);
    return () => clearInterval(interval);
  }, [loadStats]);

  const handleScopeSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = cacheScopeQuery.trim();
    setAppliedCacheScopeQuery(next);
    void loadStats(false, next);
  };

  const clearScopeSearch = (): void => {
    setCacheScopeQuery('');
    setAppliedCacheScopeQuery('');
    void loadStats(false, '');
  };

  const generatedAt = snapshot ? formatDateTime(snapshot.generatedAt) : '-';

  if (loading) {
    return <div className="p-8 text-foreground">加载中...</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="type-h1">RDF 索引</h1>
          <div className="mt-1 text-sm text-muted-foreground">更新时间 {generatedAt}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form className="flex min-w-0 items-center gap-2" onSubmit={handleScopeSearchSubmit}>
            <div className="relative w-72 max-w-[70vw]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={cacheScopeQuery}
                onChange={(event) => setCacheScopeQuery(event.target.value)}
                className="pl-9"
                placeholder="principal / base / version"
              />
            </div>
            <Button type="submit" variant="secondary" size="sm" className="gap-2">
              <Search className="h-4 w-4" />
              搜索
            </Button>
            {appliedCacheScopeQuery && (
              <Button type="button" variant="ghost" size="sm" onClick={clearScopeSearch} aria-label="清除 scope 搜索">
                <X className="h-4 w-4" />
              </Button>
            )}
          </form>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void loadStats(false)}
            disabled={refreshing}
            className="gap-2"
          >
            <RefreshCw className={clsx('h-4 w-4', refreshing && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!snapshot?.available ? (
        <>
          <UnavailablePanel snapshot={snapshot} />
          <div className="mt-8">
            <BenchmarkReportsTable snapshot={snapshot?.benchmarkReports} />
          </div>
        </>
      ) : (
        <AvailableStats snapshot={snapshot} scopeQuery={appliedCacheScopeQuery} />
      )}
    </div>
  );
}

function AvailableStats(props: { snapshot: Extract<RdfStatsSnapshot, { available: true }>; scopeQuery: string }) {
  const { snapshot, scopeQuery } = props;
  const stats = snapshot.stats;
  const rdf3x = stats.rdf3x;
  const slowQueries = stats.slowQueries?.entries ?? [];
  const derivedCache = stats.derivedCache;
  const cacheScopeEntries = derivedCache?.scopeEntries ?? [];
  const pgAcceleration = stats.pgAcceleration;
  const lifecycle = stats.lifecycle;
  const coldStart = lifecycle?.coldStart;
  const slowestColdStartPhase = coldStart?.phases.reduce(
    (slowest, phase) => phase.durationMs > slowest.durationMs ? phase : slowest,
    { name: '-', durationMs: 0 },
  );

  return (
    <>
      <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          icon={Database}
          label="引擎"
          value={snapshot.engine}
          detail={pgAcceleration?.profile ?? 'baseline'}
          tone={pgAcceleration?.enabled ? 'good' : 'neutral'}
        />
        <MetricCard
          icon={Activity}
          label="RDF-3X"
          value={rdf3x?.syncedWithFacts ? '已同步' : `${rdf3x?.refreshLag ?? 0} 版本延迟`}
          detail={`facts ${rdf3x?.factsDataVersion ?? 0} / rdf3x ${rdf3x?.rdf3xFactsDataVersion ?? 0} / pending ${rdf3x?.pendingSources ?? 0}`}
          tone={rdf3x?.syncedWithFacts ? 'good' : 'warn'}
        />
        <MetricCard
          icon={Gauge}
          label="存储"
          value={formatBytes(stats.totalBytes)}
          detail={`facts ${formatBytes(stats.factsBytes)} / derived ${formatBytes(stats.derivedBytes)}`}
          tone="neutral"
        />
        <MetricCard
          icon={RefreshCw}
          label="冷启动"
          value={formatMs(coldStart?.durationMs ?? lifecycle?.lastOpenDurationMs ?? 0)}
          detail={`${lifecycle?.status ?? 'unknown'} / open ${lifecycle?.openCount ?? 0}`}
          tone={lifecycle?.status === 'failed' ? 'warn' : 'neutral'}
        />
        <MetricCard
          icon={AlertTriangle}
          label="慢查询"
          value={`${stats.slowQueries?.entryCount ?? 0}`}
          detail={`保留 ${stats.slowQueries?.maxEntries ?? 0} 条`}
          tone={(stats.slowQueries?.entryCount ?? 0) > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Card variant="bordered">
          <CardHeader>
            <CardTitle>空间占用</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="derived/facts" value={formatRatio(stats.derivedToFactsRatio)} />
            <KeyValue label="total/facts" value={formatRatio(stats.totalToFactsRatio)} />
            <KeyValue label="result cache" value={formatBytes(stats.queryResultCache?.totalBytes ?? 0)} />
            <KeyValue label="materialized" value={formatBytes(stats.materializedResultCache?.totalBytes ?? 0)} />
            <KeyValue label="template" value={formatBytes(stats.queryTemplateCache?.totalBytes ?? 0)} />
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardHeader>
            <CardTitle>Cache</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="result entries" value={`${stats.queryResultCache?.entryCount ?? 0}`} />
            <KeyValue label="result scopes" value={`${stats.queryResultCache?.scopeCount ?? 0}`} />
            <KeyValue label="materialized entries" value={`${stats.materializedResultCache?.entryCount ?? 0}`} />
            <KeyValue label="materialized scopes" value={`${stats.materializedResultCache?.scopeCount ?? 0}`} />
            <KeyValue label="result hit rate" value={formatCacheHitRate(stats.queryResultCache)} />
            <KeyValue label="materialized hit rate" value={formatCacheHitRate(stats.materializedResultCache)} />
            <KeyValue label="template entries" value={`${stats.queryTemplateCache?.entryCount ?? 0}`} />
            <KeyValue label="cache pressure" value={formatPercent(derivedCache?.cachePressure ?? 0)} />
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardHeader>
            <CardTitle>生命周期</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="driver" value={lifecycle?.driver ?? '-'} />
            <KeyValue label="ready at" value={lifecycle?.lastReadyAt ? formatDateTime(lifecycle.lastReadyAt) : '-'} />
            <KeyValue label="slowest phase" value={`${slowestColdStartPhase?.name ?? '-'} ${formatMs(slowestColdStartPhase?.durationMs ?? 0)}`} />
            <KeyValue label="dirty sources" value={`${rdf3x?.pendingSources ?? 0}`} />
            <KeyValue label="custom index" value={coldStart ? (coldStart.customIndexDeferred ? 'deferred' : 'startup') : '-'} />
            <KeyValue label="maintenance" value={coldStart ? (coldStart.maintenanceEnabled ? 'enabled' : 'disabled') : '-'} />
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardHeader>
            <CardTitle>权限 Scope</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="scope versions" value={`${derivedCache?.scopeVersionCount ?? 0}`} />
            <KeyValue label="max scope" value={formatBytes(derivedCache?.maxScopeBytes ?? 0)} />
            <KeyValue label="largest scope" value={formatBytes(derivedCache?.largestScopeBytes ?? 0)} />
            <KeyValue label="scope pressure" value={formatPercent(derivedCache?.largestScopePressure ?? 0)} />
            <KeyValue label="scope hash" value={shortKey(derivedCache?.largestScopeHash ?? '-')} />
            <KeyValue label="facts version" value={`${derivedCache?.largestScopeFactsDataVersion ?? '-'}`} />
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardHeader>
            <CardTitle>PG 加速</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="profile" value={pgAcceleration?.profile ?? 'baseline'} />
            <KeyValue label="provider" value={pgAcceleration?.provider ?? '-'} />
            <KeyValue label="enabled" value={pgAcceleration?.enabled ? 'true' : 'false'} />
            <KeyValue label="capabilities" value={`${pgAcceleration?.capabilities?.length ?? 0}`} />
            <KeyValue label="active operators" value={formatListSummary(pgAcceleration?.activeOperators)} />
            <KeyValue label="missing caps" value={formatListSummary(pgAcceleration?.missingCapabilities)} />
            <KeyValue label="fallback" value={pgAcceleration?.fallbackReason ?? '-'} />
          </CardContent>
        </Card>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card variant="bordered">
          <CardHeader>
            <CardTitle>Cache 淘汰</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="total" value={`${derivedCache?.evictionCount ?? 0}`} />
            <EvictionBreakdown evictions={derivedCache?.evictions} />
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardHeader>
            <CardTitle>Cache 载荷</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="result payload" value={formatBytes(derivedCache?.queryResultPayloadBytes ?? 0)} />
            <KeyValue label="materialized payload" value={formatBytes(derivedCache?.materializedResultPayloadBytes ?? 0)} />
            <KeyValue label="template bytes" value={formatBytes(derivedCache?.queryTemplateBytes ?? 0)} />
            <KeyValue label="result table/index" value={`${formatBytes(stats.queryResultCache?.tableBytes ?? 0)} / ${formatBytes(stats.queryResultCache?.indexBytes ?? 0)}`} />
            <KeyValue label="materialized table/index" value={`${formatBytes(stats.materializedResultCache?.tableBytes ?? 0)} / ${formatBytes(stats.materializedResultCache?.indexBytes ?? 0)}`} />
          </CardContent>
        </Card>
      </div>

      <div className="mb-8">
        <CacheScopeTable entries={cacheScopeEntries} totalCount={derivedCache?.scopeVersionCount ?? 0} query={scopeQuery} />
      </div>

      <div className="mb-8">
        <BenchmarkReportsTable snapshot={snapshot.benchmarkReports} />
      </div>

      <SlowQueryTable entries={slowQueries} />
    </>
  );
}

function UnavailablePanel(props: { snapshot: RdfStatsSnapshot | null }) {
  const { snapshot } = props;
  const reason = snapshot?.available === false ? unavailableReasonText[snapshot.reason] : '无数据';
  return (
    <Card variant="bordered">
      <CardContent>
        <div className="flex items-center gap-3 text-muted-foreground">
          <AlertTriangle className="h-5 w-5 text-yellow-600" />
          <span>{reason}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function MetricCard(props: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'neutral';
}) {
  const Icon = props.icon;
  return (
    <Card variant="bordered">
      <CardContent>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">{props.label}</div>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div
          className={clsx(
            'text-xl font-semibold',
            props.tone === 'good' && 'text-green-600',
            props.tone === 'warn' && 'text-yellow-700',
          )}
        >
          {props.value}
        </div>
        <div className="mt-1 truncate text-sm text-muted-foreground">{props.detail}</div>
      </CardContent>
    </Card>
  );
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="min-w-0 truncate font-mono">{props.value}</span>
    </div>
  );
}

function SlowQueryTable(props: { entries: RdfSlowQueryEntry[] }) {
  return (
    <Card variant="bordered">
      <CardHeader>
        <CardTitle>最近慢查询</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {props.entries.length === 0 ? (
          <div className="px-5 pb-5 pt-4 text-sm text-muted-foreground">暂无慢查询</div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[920px] border-collapse text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">时间</th>
                  <th className="px-5 py-3 font-medium">路径</th>
                  <th className="px-5 py-3 font-medium">耗时</th>
                  <th className="px-5 py-3 font-medium">扫描</th>
                  <th className="px-5 py-3 font-medium">Cache</th>
                  <th className="px-5 py-3 font-medium">原因</th>
                </tr>
              </thead>
              <tbody>
                {props.entries.map((entry) => (
                  <tr key={`${entry.generatedAt}-${entry.queryKey}`} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs">{formatDateTime(entry.generatedAt)}</td>
                    <td className="px-5 py-3">
                      <div className="font-medium">{entry.selectedPath}</div>
                      <div className="mt-1 max-w-[240px] truncate font-mono text-xs text-muted-foreground">
                        {shortKey(entry.queryKey)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono">
                      {formatMs(entry.runtime.durationMs)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono">
                      {formatInteger(entry.runtime.scannedRows)} / {formatInteger(entry.runtime.returnedRows)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-mono text-xs">
                        tpl {entry.cache.templateStatus ?? '-'} / res {entry.cache.resultStatus ?? '-'} / mat {entry.cache.materializedStatus ?? '-'}
                      </div>
                      <div className="mt-1 max-w-[220px] truncate font-mono text-xs text-muted-foreground">
                        {formatSlowQueryCacheTarget(entry)}
                      </div>
                      <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                        {formatSlowQueryDerivedCache(entry)}
                      </div>
                      <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                        {entry.cache.scopeBasePath ?? entry.cache.scopeHash}
                      </div>
                      {entry.cache.scopePrincipal && (
                        <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                          {entry.cache.scopePrincipal}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <ReasonList reasons={entry.slowQuery.reasons} />
                      <SlowQueryPlannerDiagnostics entry={entry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SlowQueryPlannerDiagnostics(props: { entry: RdfSlowQueryEntry }) {
  const histogram = formatSlowQueryHistogramHints(props.entry);
  const rejectedNative = formatSlowQueryRejectedNativeOperators(props.entry);
  if (!histogram && !rejectedNative) {
    return null;
  }
  return (
    <div className="mt-2 max-w-[320px] space-y-1 text-xs text-muted-foreground">
      {histogram && <div className="truncate">{histogram}</div>}
      {rejectedNative && <div className="truncate">{rejectedNative}</div>}
    </div>
  );
}

function CacheScopeTable(props: { entries: RdfDerivedCacheScopeEntry[]; totalCount: number; query: string }) {
  return (
    <Card variant="bordered">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <CardTitle>权限 Scope 明细</CardTitle>
        <div className="text-sm text-muted-foreground">
          {formatInteger(props.entries.length)} / {formatInteger(props.totalCount)}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {props.entries.length === 0 ? (
          <div className="px-5 pb-5 pt-4 text-sm text-muted-foreground">
            {props.query ? '没有匹配的缓存 scope' : '暂无缓存 scope'}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[1020px] border-collapse text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Scope</th>
                  <th className="px-5 py-3 font-medium">Principal</th>
                  <th className="px-5 py-3 font-medium">Base</th>
                  <th className="px-5 py-3 font-medium">权限</th>
                  <th className="px-5 py-3 font-medium">版本</th>
                  <th className="px-5 py-3 font-medium">Payload</th>
                  <th className="px-5 py-3 font-medium">Entries</th>
                </tr>
              </thead>
              <tbody>
                {props.entries.map((entry) => (
                  <tr key={`${entry.scopeHash}-${entry.factsDataVersion}`} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs">
                      <div>{shortKey(entry.scopeHash)}</div>
                      <div className="mt-1 text-muted-foreground">facts {entry.factsDataVersion}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="max-w-[220px] truncate">{entry.principal ?? '-'}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="max-w-[260px] truncate">{entry.basePath ?? '-'}</div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs">
                      {(entry.authorizationModel ?? '-')}/{entry.mode ?? '-'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="max-w-[180px] truncate font-mono text-xs">{entry.permissionVersion ?? '-'}</div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono">
                      <div>{formatBytes(entry.payloadBytes)}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        r {formatBytes(entry.queryResultPayloadBytes)} / m {formatBytes(entry.materializedResultPayloadBytes)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono">
                      {formatInteger(entry.queryResultEntries)} / {formatInteger(entry.materializedResultEntries)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EvictionBreakdown(props: { evictions?: RdfDerivedCacheEvictionStats }) {
  const entries = Object.entries(props.evictions ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return <div className="text-sm text-muted-foreground">暂无淘汰</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {entries.map(([name, count]) => (
        <div key={name} className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">{name}</span>
          <span className="font-mono">{formatInteger(count)}</span>
        </div>
      ))}
    </div>
  );
}

function BenchmarkReportsTable(props: { snapshot?: RdfBenchmarkReportCatalogSnapshot }) {
  const reports = props.snapshot?.reports ?? [];
  const errors = props.snapshot?.errors ?? [];
  return (
    <Card variant="bordered">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Benchmark 报告</CardTitle>
          <div className="mt-1 max-w-[720px] truncate text-sm text-muted-foreground">
            {(props.snapshot?.roots ?? []).join(', ') || '未配置目录'}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BarChart3 className="h-4 w-4" />
          {formatInteger(props.snapshot?.reportCount ?? reports.length)}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {errors.length > 0 && (
          <div className="border-b border-border px-5 py-3 text-sm text-yellow-700">
            {formatInteger(errors.length)} 个报告读取失败，最近一个：{errors[0].path} - {errors[0].message}
          </div>
        )}
        {reports.length === 0 ? (
          <div className="px-5 pb-5 pt-4 text-sm text-muted-foreground">暂无 benchmark report</div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">时间</th>
                  <th className="px-5 py-3 font-medium">Profile</th>
                  <th className="px-5 py-3 font-medium">规模</th>
                  <th className="px-5 py-3 font-medium">Gate</th>
                  <th className="px-5 py-3 font-medium">Ingest</th>
                  <th className="px-5 py-3 font-medium">Refresh</th>
                  <th className="px-5 py-3 font-medium">Cold / Warm</th>
                  <th className="px-5 py-3 font-medium">Storage</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <BenchmarkReportRow key={`${report.path}-${report.generatedAt}`} report={report} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BenchmarkReportRow(props: { report: RdfBenchmarkReportSummary }) {
  const report = props.report;
  const failedPlanCount = report.failedPlanCases.length;
  const failedConcurrencyCount = report.failedConcurrencyCases.length;
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="whitespace-nowrap px-5 py-3">
        <div className="font-mono text-xs">{formatDateTime(report.generatedAt)}</div>
        <div className="mt-1 max-w-[220px] truncate font-mono text-xs text-muted-foreground">{report.path}</div>
      </td>
      <td className="px-5 py-3">
        <div className="font-medium">{report.rdfAccelerationProfile ?? report.engine}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {report.driver ?? report.engine} / {report.caseProfile ?? '-'}
        </div>
        <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
          {report.pgAccelerationFallbackReason ?? formatListSummary(report.pgActiveOperators)}
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-3 font-mono">
        <div>{formatInteger(report.seedQuadCount ?? 0)} / {formatInteger(report.targetQuadCount ?? 0)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {report.scale ?? '-'} / {report.fullScale === false ? 'partial' : 'full'}
        </div>
      </td>
      <td className="px-5 py-3">
        <StatusPill ok={report.planMatched !== false && failedPlanCount === 0} label={`plan ${report.planMatched === false ? 'fail' : 'ok'}`} />
        <div className="mt-1">
          <StatusPill ok={report.concurrencyMatched !== false && failedConcurrencyCount === 0} label={`conc ${report.concurrency ?? 1}`} />
        </div>
        {(failedPlanCount > 0 || failedConcurrencyCount > 0) && (
          <div className="mt-1 text-xs text-yellow-700">
            fail {formatInteger(failedPlanCount + failedConcurrencyCount)}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-5 py-3 font-mono">
        <div>{formatMs(report.ingestDurationMs ?? 0)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          COPY {formatInteger(report.copyRows ?? 0)} / fb {formatInteger(report.copyFallbacks ?? 0)}
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-3 font-mono">
        <div>{formatMs(report.refreshDurationMs ?? 0)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          planner {formatMs(report.plannerStatsDurationMs ?? 0)}
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-3 font-mono">
        <div>{formatMs(report.coldStartDurationMs ?? 0)} / {formatMs(report.firstQueryDurationMs ?? 0)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          p50/p95 {formatMs(report.warmP50DurationMs ?? 0)} / {formatMs(report.warmP95DurationMs ?? 0)}
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-3 font-mono">
        <div>{formatRatio(report.storageTotalToFactsRatio ?? 0)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatBytes(report.storageTotalBytes ?? 0)}
        </div>
      </td>
    </tr>
  );
}

function StatusPill(props: { ok: boolean; label: string }) {
  return (
    <span className={clsx(
      'inline-flex rounded-md px-2 py-0.5 text-xs',
      props.ok ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-800',
    )}>
      {props.label}
    </span>
  );
}

function ReasonList(props: { reasons: string[] }) {
  return (
    <div className="flex max-w-[320px] flex-wrap gap-1.5">
      {props.reasons.map((reason) => (
        <span key={reason} className="rounded-md bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">
          {reason}
        </span>
      ))}
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return '0.00x';
  }
  return `${value.toFixed(2)}x`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  return `${Math.round(value * 100)}%`;
}

function formatCacheHitRate(cache: { hitCount: number; missCount: number } | undefined): string {
  const hits = cache?.hitCount ?? 0;
  const misses = cache?.missCount ?? 0;
  const total = hits + misses;
  if (total <= 0) {
    return '-';
  }
  return `${formatPercent(hits / total)} (${formatInteger(hits)}/${formatInteger(total)})`;
}

function formatSlowQueryCacheTarget(entry: RdfSlowQueryEntry): string {
  const materializedKey = entry.cache.materialized?.key;
  if (materializedKey) {
    return `mat ${shortKey(materializedKey)}`;
  }
  const resultKey = entry.cache.result?.key ?? entry.queryKey;
  return `res ${shortKey(resultKey)}`;
}

function formatSlowQueryDerivedCache(entry: RdfSlowQueryEntry): string {
  const cache = entry.derivedCache;
  const pressure = formatPercent(cache.cachePressure);
  const scopePressure = formatPercent(cache.largestScopePressure);
  const evictions = cache.evictionCount;
  return `pressure ${pressure} / scope ${scopePressure} / evict ${formatInteger(evictions)}`;
}

function formatSlowQueryHistogramHints(entry: RdfSlowQueryEntry): string {
  const hints = entry.histogramHints ?? [];
  if (hints.length === 0) {
    return '';
  }
  const summary = hints.map((hint) => `${hint.kind}:${formatInteger(hint.quadCount)}`);
  return `hist ${formatInteger(hints.length)} ${formatListSummary(summary)}`;
}

function formatSlowQueryRejectedNativeOperators(entry: RdfSlowQueryEntry): string {
  const rejected = entry.rejectedNativeOperators ?? [];
  if (rejected.length === 0) {
    return '';
  }
  const summary = rejected.map((operator) => `${operator.capability}:${operator.reason}`);
  return `native rejected ${formatInteger(rejected.length)} ${formatListSummary(summary)}`;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) {
    return '0 ms';
  }
  return `${Math.round(value)} ms`;
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function shortKey(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}...${value.slice(-4)}`;
}

function formatListSummary(values?: string[]): string {
  if (!values?.length) {
    return '-';
  }
  if (values.length <= 2) {
    return values.join(', ');
  }
  return `${values.slice(0, 2).join(', ')} +${values.length - 2}`;
}
