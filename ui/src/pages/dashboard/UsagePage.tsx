import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@undefineds.co/shared-ui';
import { ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { storedAccountTokenHeaders } from '../../utils/account-session';
import { useXpodAuth } from '../../auth/useXpodAuth';
import { PaneListHeader } from '../settings/PaneListHeader';

interface AccountUsageResponse {
  accountId: string;
  usage: {
    storageBytes: number;
    ingressBytes: number;
    egressBytes: number;
    computeSeconds: number;
    tokensUsed: number;
    periodStart: string | null;
  };
}

export default function UsagePage() {
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

  const summary = useMemo(() => {
    const usage = data?.usage;
    return usage ? [
      ['Storage', formatBytes(usage.storageBytes)],
      ['Ingress', formatBytes(usage.ingressBytes)],
      ['Egress', formatBytes(usage.egressBytes)],
      ['Compute', `${usage.computeSeconds.toLocaleString()} s`],
      ['Tokens', usage.tokensUsed.toLocaleString()],
    ] : [];
  }, [data]);

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
              {accountId ?? 'Account identity unavailable'}
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
            onClick={() => void loadUsage()}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>
      )}
      main={(
        <section className="flex min-h-full flex-col gap-4 bg-background p-6">
          {error ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
          <Card>
            <CardHeader>
              <CardTitle>Current period</CardTitle>
              <CardDescription>{data?.usage.periodStart ? `Since ${formatDate(data.usage.periodStart)}` : 'Account usage reported by the API'}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {summary.length > 0 ? summary.map(([label, value]) => (
                <div key={label} className="rounded-md border border-border bg-muted/30 p-3">
                  <div className="text-xs font-medium text-muted-foreground">{label}</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
                </div>
              )) : <div className="text-sm text-muted-foreground">{loading ? 'Loading account usage' : 'No account usage reported'}</div>}
            </CardContent>
          </Card>
        </section>
      )}
      className="min-h-full"
    />
  );
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
  return Number.isNaN(date.getTime()) ? 'current period' : date.toLocaleDateString();
}
