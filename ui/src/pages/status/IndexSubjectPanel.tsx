import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@undefineds.co/shared-ui';
import { RefreshCw } from 'lucide-react';
import { getRdfStats, type RdfStatsSnapshot } from '../../api/admin';

export type IndexSubjectKind = 'overview' | 'fts' | 'vector' | 'retrieval-points' | 'cache' | 'slow-queries' | 'benchmark';

export default function IndexSubjectPanel({ kind }: { kind: IndexSubjectKind }) {
  const [snapshot, setSnapshot] = useState<RdfStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setSnapshot(await getRdfStats()); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        void load();
      }
    });
    return () => {
      active = false;
    };
  }, [load]);
  return <div className="space-y-4 p-6">
    <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
    <div role="status" aria-live="polite" className="sr-only">{loading ? 'Refreshing index evidence…' : snapshot ? 'Index evidence refreshed.' : 'Waiting for index evidence.'}</div>
    <Card><CardHeader><CardTitle>{titles[kind]}</CardTitle><CardDescription>Observed derived-index state; policy changes belong in AI Config.</CardDescription></CardHeader><CardContent>{loading && !snapshot ? <MetricsSkeleton /> : content(kind, snapshot)}</CardContent></Card>
  </div>;
}

const titles: Record<IndexSubjectKind, string> = {
  overview: 'Index Overview', fts: 'FTS', vector: 'Vector', 'retrieval-points': 'Retrieval Points', cache: 'Cache', 'slow-queries': 'Slow Queries', benchmark: 'Benchmark',
};

function content(kind: IndexSubjectKind, snapshot: RdfStatsSnapshot | null) {
  if (!snapshot) return <p className="text-sm text-muted-foreground">Waiting for runtime evidence.</p>;
  if (kind === 'benchmark') {
    const reports = snapshot.benchmarkReports;
    return <Metrics values={[['Reports', String(reports?.reportCount ?? 0)], ['Skipped files', String(reports?.skippedFiles ?? 0)], ['Errors', String(reports?.errors.length ?? 0)]]} />;
  }
  if (!snapshot.available) return <p className="text-sm text-muted-foreground">Unavailable: {snapshot.reason}</p>;
  if (kind === 'overview') {
    const lifecycle = snapshot.stats.lifecycle;
    return <div className="space-y-4">
      <Metrics values={[
        ['Engine', snapshot.engine], ['State', displayState(lifecycle?.status)],
        ['Authority data', formatBytes(snapshot.stats.factsBytes)], ['Derived storage', formatBytes(snapshot.stats.derivedBytes)],
        ['Total storage', formatBytes(snapshot.stats.totalBytes)], ['Generated', formatTimestamp(snapshot.generatedAt)],
      ]} />
      <EvidenceNote>Derived indexes are rebuildable runtime evidence; Pod RDF remains the authority data.</EvidenceNote>
    </div>;
  }
  if (kind === 'cache') {
    const cache = snapshot.stats.derivedCache;
    return cache ? <Metrics values={[['Cache bytes', formatBytes(cache.cacheBytes)], ['Limit', formatBytes(cache.maxCacheBytes)], ['Pressure', `${Math.round(cache.cachePressure * 100)}%`], ['Evictions', String(cache.evictionCount)]]} /> : <Unavailable />;
  }
  if (kind === 'slow-queries') {
    const slow = snapshot.stats.slowQueries;
    return slow ? <div className="space-y-2"><Metrics values={[['Captured', String(slow.entryCount)], ['Limit', String(slow.maxEntries)]]} />{slow.entries.slice(0, 10).map((entry) => <div key={`${entry.generatedAt}-${entry.queryKey}`} className="rounded-lg border border-border p-3 text-sm"><div className="font-medium">{entry.runtime.durationMs} ms · {entry.runtime.returnedRows} rows</div><div className="mt-1 text-xs text-muted-foreground">{entry.reasons.join(', ') || entry.queryKey}</div></div>)}</div> : <Unavailable />;
  }
  if (kind === 'retrieval-points') {
    const retrieval = snapshot.stats.rdf3x;
    return retrieval ? <Metrics values={[
      ['State', retrieval.syncedWithFacts ? 'Synchronized' : `${retrieval.refreshLag} versions behind`],
      ['Facts version', String(retrieval.factsDataVersion)], ['Retrieval version', String(retrieval.rdf3xFactsDataVersion)],
      ['Pending sources', String(retrieval.pendingSources)],
    ]} /> : <Unavailable />;
  }
  const lifecycle = snapshot.stats.lifecycle;
  const owned = kind === 'fts' ? lifecycle?.coldStart?.ownsTextIndex : lifecycle?.coldStart?.ownsVectorIndex;
  if ((kind === 'fts' || kind === 'vector') && owned) {
    const acceleration = snapshot.stats.pgAcceleration;
    const freshness = snapshot.stats.rdf3x;
    return <div className="space-y-4">
      <Metrics values={[
        ['State', displayState(lifecycle?.status)], ['Ownership', 'Runtime managed'],
        ['Backend', acceleration?.provider ? `${capitalize(acceleration.provider)}${acceleration.version ? ` ${acceleration.version}` : ''}` : lifecycle?.driver ?? 'Not reported'],
        ['Freshness', freshness ? (freshness.syncedWithFacts ? 'Current' : `${freshness.refreshLag} versions behind`) : 'Not reported'],
        ['Indexes', acceleration?.customIndexes?.map((index) => index.name).join(', ') || 'Runtime managed'],
        ['Last ready', formatTimestamp(lifecycle?.lastReadyAt)],
      ]} />
      <EvidenceNote>{kind === 'fts' ? 'Text retrieval' : 'Vector retrieval'} is derived from Pod authority data. Enablement and backend policy are configured in AI Config.</EvidenceNote>
    </div>;
  }
  return <Unavailable />;
}

function Metrics({ values }: { values: Array<[string, string]> }) { return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{values.map(([label, value]) => <div key={label} className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>)}</div>; }
function MetricsSkeleton() { return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index} className="rounded-lg border border-border p-3"><Skeleton className="h-3 w-20" /><Skeleton className="mt-2 h-5 w-28" /></div>)}</div>; }
function Unavailable() { return <p className="text-sm text-muted-foreground">This runtime does not report evidence for this index subject.</p>; }
function EvidenceNote({ children }: { children: ReactNode }) { return <p className="text-sm text-muted-foreground">{children}</p>; }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
function formatTimestamp(value: string | undefined): string { return value ? new Date(value).toLocaleString() : 'Not reported'; }
function displayState(value: string | undefined): string { return value ? capitalize(value) : 'Unknown'; }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
