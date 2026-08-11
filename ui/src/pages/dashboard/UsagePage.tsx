import { useCallback, useEffect, useRef, useState } from 'react';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@undefineds.co/shared-ui';
import { ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { storedAccountTokenHeaders } from '../../utils/account-session';
import { useXpodAuth } from '../../auth/useXpodAuth';
import { PaneListHeader } from '../settings/PaneListHeader';

export type AccountUsageKind = 'overview' | 'storage' | 'bandwidth' | 'ai' | 'index-storage';

export interface AccountUsageResponse {
  accountId: string;
  usage: {
    storageBytes: number;
    ingressBytes: number;
    egressBytes: number;
    computeSeconds: number;
    tokensUsed: number;
    periodStart: string | null;
  };
  limits?: {
    storageLimitBytes: number | null;
    bandwidthLimitBps: number | null;
    computeLimitSeconds: number | null;
    tokenLimitMonthly: number | null;
  };
}

export interface AccountUsagePanelProps {
  kind?: AccountUsageKind;
  embedded?: boolean;
}

export default function UsagePage({ kind = 'overview', embedded = false }: AccountUsagePanelProps = {}) {
  const usage = useAccountUsage();
  const content = (
    <UsageContent
      accountId={usage.accountId}
      data={usage.data}
      error={usage.error}
      kind={kind}
      loading={usage.loading}
      onRefresh={() => void usage.loadUsage()}
      showRefresh={embedded}
    />
  );

  if (embedded) return content;

  return (
    <TwoPaneLayout
      mode="auto"
      listHeader={<PaneListHeader title="Usage" />}
      list={(
        <aside className="flex h-full flex-col gap-3 border-r border-border bg-muted/30 p-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ChartNoAxesCombined className="h-4 w-4" aria-hidden="true" />
                Account usage
              </CardTitle>
              <CardDescription>Usage belongs to the signed-in Account.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {usage.accountId ?? 'Account identity unavailable'}
            </CardContent>
          </Card>
        </aside>
      )}
      mainHeader={(
        <div className="flex h-full min-w-0 items-center justify-between gap-4 px-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">Usage</div>
            <div className="truncate text-xs text-muted-foreground">Account-level storage, bandwidth, compute, and token usage</div>
          </div>
          <button
            type="button"
            onClick={() => void usage.loadUsage()}
            disabled={usage.loading}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>
      )}
      main={content}
      className="min-h-full"
    />
  );
}

function useAccountUsage() {
  const { account } = useXpodAuth();
  const accountId = account.identity?.id ?? account.identity?.username;
  const [data, setData] = useState<AccountUsageResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestIdRef = useRef(0);
  const accountIdRef = useRef(accountId);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const isCurrentRequest = useCallback((requestId: number, requestedAccountId: string | undefined) => (
    mountedRef.current
    && requestIdRef.current === requestId
    && accountIdRef.current === requestedAccountId
  ), []);

  const loadUsage = useCallback(async () => {
    const requestedAccountId = accountId;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = () => isCurrentRequest(requestId, requestedAccountId);

    if (!requestedAccountId) {
      if (isCurrent()) {
        setData(undefined);
        setError(undefined);
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/v1/usage/accounts/${encodeURIComponent(requestedAccountId)}`, {
        method: 'GET',
        credentials: 'include',
        headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
      });
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error('Account usage request failed. Please try again.');
      }
      const nextData = await response.json() as AccountUsageResponse;
      if (isCurrent()) {
        setData(nextData);
      }
    } catch {
      if (isCurrent()) {
        setError('Account usage request failed. Please try again.');
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, [accountId, isCurrentRequest]);

  useEffect(() => {
    let cancelled = false;
    accountIdRef.current = accountId;
    requestIdRef.current += 1;
    queueMicrotask(() => {
      if (cancelled || !mountedRef.current) return;
      setData(undefined);
      setError(undefined);
      setLoading(Boolean(accountId));
      void loadUsage();
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, loadUsage]);

  return { accountId, data, error, loading, loadUsage };
}

function UsageContent({
  accountId,
  data,
  error,
  kind,
  loading,
  onRefresh,
  showRefresh,
}: {
  accountId?: string;
  data?: AccountUsageResponse;
  error?: string;
  kind: AccountUsageKind;
  loading: boolean;
  onRefresh: () => void;
  showRefresh: boolean;
}) {
  return (
    <section className="flex min-h-full flex-col gap-4 bg-background p-6">
      {showRefresh ? <div className="flex items-center justify-between gap-4">
        <div className="text-xs text-muted-foreground">{accountId ?? 'Account identity unavailable'}</div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div> : null}
      {error ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      <div role="status" aria-live="polite" className="sr-only">{loading ? 'Refreshing account usage…' : data ? 'Account usage refreshed.' : 'Waiting for account usage.'}</div>
      {loading && !data ? <UsageSkeleton count={kind === 'overview' ? 4 : 1} /> : (
        <>
          {(kind === 'overview' || kind === 'storage') && <StorageCard data={data} />}
          {(kind === 'overview' || kind === 'bandwidth') && <BandwidthCard data={data} />}
          {(kind === 'overview' || kind === 'ai') && <AiUsageCard data={data} />}
          {(kind === 'overview' || kind === 'index-storage') && <IndexStorageCard data={data} />}
        </>
      )}
    </section>
  );
}

function UsageSkeleton({ count }: { count: number }) {
  return <div className="space-y-4"><div className="text-sm text-muted-foreground">Loading account usage</div><div aria-hidden="true">{Array.from({ length: count }, (_, index) => <Card key={index}><CardHeader><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-64 max-w-full" /></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((item) => <div key={item} className="rounded-lg border border-border p-3"><Skeleton className="h-3 w-20" /><Skeleton className="mt-2 h-5 w-28" /></div>)}</div></CardContent></Card>)}</div></div>;
}

function StorageCard({ data }: { data?: AccountUsageResponse }) {
  const usage = data?.usage;
  return <Card><CardHeader><CardTitle>Storage</CardTitle><CardDescription>Measured storage usage for the signed-in Account</CardDescription></CardHeader><CardContent>
    {usage ? <div className="grid gap-3 sm:grid-cols-2"><Metric label="Used" value={formatBytes(usage.storageBytes)} /><Metric label="Limit" value={data?.limits?.storageLimitBytes == null ? 'Unlimited' : formatBytes(data.limits.storageLimitBytes)} /></div> : <Unavailable />}
  </CardContent></Card>;
}

function BandwidthCard({ data }: { data?: AccountUsageResponse }) {
  const usage = data?.usage;
  return <Card><CardHeader><CardTitle>Bandwidth</CardTitle><CardDescription>Measured ingress and egress for the signed-in Account</CardDescription></CardHeader><CardContent>
    {usage ? <div className="grid gap-3 sm:grid-cols-3"><Metric label="Ingress" value={formatBytes(usage.ingressBytes)} /><Metric label="Egress" value={formatBytes(usage.egressBytes)} /><Metric label="Rate limit" value={data?.limits?.bandwidthLimitBps == null ? 'Unlimited' : `${formatBytes(data.limits.bandwidthLimitBps)}/s`} /></div> : <Unavailable />}
  </CardContent></Card>;
}

function AiUsageCard({ data }: { data?: AccountUsageResponse }) {
  const usage = data?.usage;
  return <Card><CardHeader><CardTitle>AI Usage</CardTitle><CardDescription>Measured aggregate token and compute consumption for the signed-in Account</CardDescription></CardHeader><CardContent>
    {usage ? <div className="grid gap-3 sm:grid-cols-2"><Metric label="Compute" value={`${usage.computeSeconds.toLocaleString()} s`} /><Metric label="Tokens" value={usage.tokensUsed.toLocaleString()} /></div> : <Unavailable />}
  </CardContent></Card>;
}

function IndexStorageCard({ data }: { data?: AccountUsageResponse }) {
  const usage = data?.usage;
  return <Card><CardHeader><CardTitle>Index Storage</CardTitle><CardDescription>Account-owned storage reported by the usage API</CardDescription></CardHeader><CardContent>
    {usage ? <div className="grid gap-3 sm:grid-cols-2"><Metric label="Stored" value={formatBytes(usage.storageBytes)} /><Metric label="Period" value={usage.periodStart ? formatDate(usage.periodStart) : 'Current'} /></div> : <Unavailable />}
  </CardContent></Card>;
}

function Unavailable() {
  return <div className="text-sm text-muted-foreground">Account usage is not reported yet.</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(amount) ? amount : amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Current' : date.toLocaleDateString();
}
