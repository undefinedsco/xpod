import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@undefineds.co/shared-ui';
import { RefreshCw } from 'lucide-react';
import { fetchPodSettingsStatus, type PodSettingsStatus } from '../../api/pod-settings';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { getRdfStats, type RdfStatsSnapshot } from '../../api/admin';
import { projectAiUsage, projectIndexStorage } from './usage-projection';

export type UsageStatusKind = 'overview' | 'storage' | 'bandwidth' | 'ai' | 'index-storage';

export default function UsageStatusPanel({ kind }: { kind: UsageStatusKind }) {
  const runtime = useXpodSolidRuntime();
  const [status, setStatus] = useState<PodSettingsStatus>();
  const [rdfStats, setRdfStats] = useState<RdfStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!runtime.webId || !runtime.podUrl) return;
    setLoading(true);
    setError(undefined);
    try {
      const [nextStatus, nextRdfStats] = await Promise.all([
        fetchPodSettingsStatus({ webId: runtime.webId, podUrl: runtime.podUrl, authenticatedFetch: runtime.fetch }),
        (kind === 'overview' || kind === 'index-storage') ? getRdfStats() : Promise.resolve(null),
      ]);
      setStatus(nextStatus);
      setRdfStats(nextRdfStats);
    } catch {
      setError('Usage status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [kind, runtime.fetch, runtime.podUrl, runtime.webId]);
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
    <div role="status" aria-live="polite" className="sr-only">{loading ? 'Refreshing usage evidence…' : status ? 'Usage evidence refreshed.' : 'Waiting for usage evidence.'}</div>
    {error && <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</div>}
    {loading && !status ? <UsageSkeleton count={kind === 'overview' ? 4 : 1} /> : <>
    {(kind === 'overview' || kind === 'storage') && <StorageCard status={status} />}
    {(kind === 'overview' || kind === 'bandwidth') && <BandwidthCard status={status} />}
    {(kind === 'overview' || kind === 'ai') && <AiUsageCard status={status} />}
    {(kind === 'overview' || kind === 'index-storage') && <IndexStorageCard snapshot={rdfStats} />}
    </>}
  </div>;
}

function UsageSkeleton({ count }: { count: number }) { return <div className="space-y-4" aria-hidden="true">{Array.from({ length: count }, (_, index) => <Card key={index}><CardHeader><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-64 max-w-full" /></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((item) => <div key={item} className="rounded-lg border border-border p-3"><Skeleton className="h-3 w-20" /><Skeleton className="mt-2 h-5 w-28" /></div>)}</div></CardContent></Card>)}</div>; }

function StorageCard({ status }: { status?: PodSettingsStatus }) {
  const storage = status?.storage;
  return <Card><CardHeader><CardTitle>Storage</CardTitle><CardDescription>Measured authority-data usage for the current Pod</CardDescription></CardHeader><CardContent>
    {storage?.status === 'available' ? <div className="grid gap-3 sm:grid-cols-2"><Metric label="Used" value={formatBytes(storage.usage.storageBytes)} /><Metric label="Limit" value={storage.limits.storageLimitBytes == null ? 'Unlimited' : formatBytes(storage.limits.storageLimitBytes)} /></div> : <Unavailable reason={storage?.reason} />}
  </CardContent></Card>;
}

function BandwidthCard({ status }: { status?: PodSettingsStatus }) {
  const storage = status?.storage;
  return <Card><CardHeader><CardTitle>Bandwidth</CardTitle><CardDescription>Measured ingress and egress for the current Pod</CardDescription></CardHeader><CardContent>
    {storage?.status === 'available' ? <div className="grid gap-3 sm:grid-cols-3"><Metric label="Ingress" value={formatBytes(storage.usage.ingressBytes)} /><Metric label="Egress" value={formatBytes(storage.usage.egressBytes)} /><Metric label="Rate limit" value={storage.limits.bandwidthLimitBps == null ? 'Unlimited' : `${formatBytes(storage.limits.bandwidthLimitBps)}/s`} /></div> : <Unavailable reason={storage?.reason} />}
  </CardContent></Card>;
}

function AiUsageCard({ status }: { status?: PodSettingsStatus }) {
  const storage = status?.storage;
  return <Card><CardHeader><CardTitle>AI Usage</CardTitle><CardDescription>Measured aggregate token and compute consumption for the current Pod</CardDescription></CardHeader><CardContent>
    {storage?.status === 'available' ? <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{projectAiUsage(storage).map(([label, value]) => <Metric key={label} label={label} value={value} />)}</div><p className="mt-3 text-xs text-muted-foreground">Capability/provider/model grouping is unavailable because this runtime currently records aggregate Pod usage only.</p></> : <Unavailable reason={storage?.reason ?? 'AI consumption is not reported by this runtime.'} />}
  </CardContent></Card>;
}

function IndexStorageCard({ snapshot }: { snapshot: RdfStatsSnapshot | null }) {
  return <Card><CardHeader><CardTitle>Index Storage</CardTitle><CardDescription>Authority data versus rebuildable derived-index storage</CardDescription></CardHeader><CardContent>{snapshot?.available ? <div className="grid gap-3 sm:grid-cols-3">{projectIndexStorage(snapshot.stats).map(([label, value]) => <Metric key={label} label={label} value={value} />)}</div> : <Unavailable reason={snapshot ? snapshot.reason : 'Waiting for runtime evidence.'} />}</CardContent></Card>;
}

function Unavailable({ reason = 'Waiting for runtime evidence.' }: { reason?: string }) { return <div className="text-sm text-muted-foreground">{reason}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>; }
function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let amount = Math.max(0, value); let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${Number.isInteger(amount) ? amount : amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}
