/**
 * RDF 页面 - 索引与查询观测
 */

import type { ComponentType } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Database, Gauge, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { getRdfStats, type RdfSlowQueryEntry, type RdfStatsSnapshot } from '@/api/admin';

const unavailableReasonText: Record<NonNullable<Extract<RdfStatsSnapshot, { available: false }>['reason']>, string> = {
  'not-cloud': '非 Cloud 模式',
  'missing-sparql-endpoint': '缺少 PostgreSQL 端点',
  'unsupported-sparql-endpoint': '非 PostgreSQL 端点',
};

export function RdfPage() {
  const [snapshot, setSnapshot] = useState<RdfStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadStats = useCallback(async (initial = false): Promise<void> => {
    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError('');
    try {
      const next = await getRdfStats();
      if (next) {
        setSnapshot(next);
      } else {
        setError('RDF stats unavailable');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadStats(true);
    const interval = setInterval(() => void loadStats(false), 10_000);
    return () => clearInterval(interval);
  }, [loadStats]);

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

      {error && (
        <div className="mb-5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!snapshot?.available ? (
        <UnavailablePanel snapshot={snapshot} />
      ) : (
        <AvailableStats snapshot={snapshot} />
      )}
    </div>
  );
}

function AvailableStats(props: { snapshot: Extract<RdfStatsSnapshot, { available: true }> }) {
  const { snapshot } = props;
  const stats = snapshot.stats;
  const rdf3x = stats.rdf3x;
  const slowQueries = stats.slowQueries?.entries ?? [];

  return (
    <>
      <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Database}
          label="引擎"
          value={snapshot.engine}
          detail={stats.pgAcceleration?.profile ?? 'baseline'}
          tone={stats.pgAcceleration?.enabled ? 'good' : 'neutral'}
        />
        <MetricCard
          icon={Activity}
          label="RDF-3X"
          value={rdf3x?.syncedWithFacts ? '已同步' : `${rdf3x?.refreshLag ?? 0} 版本延迟`}
          detail={`facts ${rdf3x?.factsDataVersion ?? 0} / rdf3x ${rdf3x?.rdf3xFactsDataVersion ?? 0}`}
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
          icon={AlertTriangle}
          label="慢查询"
          value={`${stats.slowQueries?.entryCount ?? 0}`}
          detail={`保留 ${stats.slowQueries?.maxEntries ?? 0} 条`}
          tone={(stats.slowQueries?.entryCount ?? 0) > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-5 xl:grid-cols-3">
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
            <KeyValue label="materialized entries" value={`${stats.materializedResultCache?.entryCount ?? 0}`} />
            <KeyValue label="template entries" value={`${stats.queryTemplateCache?.entryCount ?? 0}`} />
            <KeyValue label="cache pressure" value={formatPercent(stats.derivedCache?.cachePressure ?? 0)} />
            <KeyValue label="evictions" value={`${stats.derivedCache?.evictionCount ?? 0}`} />
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardHeader>
            <CardTitle>PG 加速</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyValue label="profile" value={stats.pgAcceleration?.profile ?? 'baseline'} />
            <KeyValue label="provider" value={stats.pgAcceleration?.provider ?? '-'} />
            <KeyValue label="enabled" value={stats.pgAcceleration?.enabled ? 'true' : 'false'} />
            <KeyValue label="active operators" value={`${stats.pgAcceleration?.activeOperators?.length ?? 0}`} />
            <KeyValue label="missing caps" value={`${stats.pgAcceleration?.missingCapabilities?.length ?? 0}`} />
          </CardContent>
        </Card>
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
                        tpl {entry.cache.templateStatus ?? '-'} / res {entry.cache.resultStatus ?? '-'}
                      </div>
                      <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                        {entry.cache.scopeBasePath ?? entry.cache.scopeHash}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <ReasonList reasons={entry.slowQuery.reasons} />
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
