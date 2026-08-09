import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@undefineds.co/shared-ui';
import { Database, ExternalLink, LogIn, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchPodSettingsStatus, type PodSettingsStatus } from '../../api/pod-settings';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { PaneListHeader } from './PaneListHeader';

export default function PodPage({ view = 'combined' }: { view?: 'combined' | 'settings' | 'usage' }) {
  const runtime = useXpodSolidRuntime();
  const [status, setStatus] = useState<PodSettingsStatus>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const activeIdentityKeyRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const canLoad = runtime.state.status === 'authenticated' && Boolean(runtime.webId && runtime.podUrl);
  const identityKey = canLoad ? `${runtime.webId}\n${runtime.podUrl}` : undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    const webId = runtime.webId;
    const podUrl = runtime.podUrl;
    const requestIdentityKey = identityKey;
    if (!webId || !podUrl || !requestIdentityKey) {
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrentRequest = () => (
      mountedRef.current
      && requestIdRef.current === requestId
      && activeIdentityKeyRef.current === requestIdentityKey
    );

    setLoading(true);
    setError(undefined);
    try {
      const nextStatus = await fetchPodSettingsStatus({
        webId,
        podUrl,
        authenticatedFetch: runtime.fetch,
      });
      if (isCurrentRequest()) {
        setStatus(nextStatus);
      }
    } catch {
      if (isCurrentRequest()) {
        setError('Pod 设置请求失败，请重试。');
      }
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [identityKey, runtime.fetch, runtime.podUrl, runtime.webId]);

  useEffect(() => {
    activeIdentityKeyRef.current = identityKey;
    requestIdRef.current += 1;
    setStatus(undefined);
    setError(undefined);
    setLoading(false);
    if (identityKey) {
      void loadStatus();
    }
  }, [identityKey, loadStatus]);

  const identity = useMemo(() => ({
    webId: runtime.webId ?? status?.identity.webId,
    podUrl: runtime.podUrl ?? status?.identity.podUrl,
    issuer: runtime.issuer,
  }), [runtime.issuer, runtime.podUrl, runtime.webId, status]);

  const openPod = () => {
    if (!identity.podUrl) return;
    window.open(identity.podUrl, '_blank', 'noopener,noreferrer');
  };

  const loginAgain = () => {
    if (!runtime.issuer) return;
    void runtime.login(runtime.issuer);
  };

  return (
    <TwoPaneLayout
      mode="auto"
      listHeader={<PaneListHeader title={view === 'usage' ? 'Usage' : 'Pod'} />}
      list={
        <aside className="flex h-full flex-col gap-3 border-r border-border bg-muted/30 p-4">
          {view !== 'usage' ? (
            <IdentityCard
              webId={identity.webId}
              podUrl={identity.podUrl}
              issuer={identity.issuer}
              sessionStatus={runtime.state.status}
              onOpenPod={openPod}
              onLogout={() => void runtime.logout()}
              onLoginAgain={loginAgain}
              canLoginAgain={Boolean(runtime.issuer)}
            />
          ) : null}
          {view !== 'settings' ? <PodUsageCard storage={status?.storage} loading={loading && !status} /> : null}
        </aside>
      }
      mainHeader={<PodHeader title={view === 'usage' ? 'Usage' : 'Pod'} loading={loading} onRefresh={loadStatus} />}
      main={
        <section className="flex min-h-full flex-col gap-4 bg-background p-6">
          {error ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                访问边界
              </CardTitle>
              <CardDescription>
                此页面仅读取已认证的 Solid 会话与当前 Pod。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm text-muted-foreground">
              <KeyValue label="会话" value={runtime.state.status} />
              <KeyValue label="状态生成时间" value={formatDateTime(status?.generatedAt)} />
            </CardContent>
          </Card>
        </section>
      }
      className="min-h-full"
    />
  );
}

export function IdentityCard({
  webId,
  podUrl,
  issuer,
  sessionStatus,
  onOpenPod,
  onLogout,
  onLoginAgain,
  canLoginAgain,
}: {
  webId?: string;
  podUrl?: string;
  issuer?: string;
  sessionStatus: string;
  onOpenPod: () => void;
  onLogout: () => void;
  onLoginAgain: () => void;
  canLoginAgain: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">身份</CardTitle>
        <CardDescription>当前 Solid 会话</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3 text-sm">
          <KeyValue label="WebID" value={webId ?? '未登录'} />
          <KeyValue label="Pod" value={podUrl ?? '发现中'} />
          <KeyValue label="Issuer" value={issuer ?? '未知'} />
          <KeyValue label="状态" value={sessionStatus} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onOpenPod} disabled={!podUrl}>
            <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
            打开 Pod
          </Button>
          <Button type="button" size="sm" variant="subtle" onClick={onLogout}>
            <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
            退出登录
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onLoginAgain} disabled={!canLoginAgain}>
            <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
            重新登录
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PodUsageCard({
  storage,
  loading,
}: {
  storage?: PodSettingsStatus['storage'];
  loading: boolean;
}) {
  const available = storage?.status === 'available';
  const percent = available && storage.limits.storageLimitBytes
    ? Math.min(100, Math.round((storage.usage.storageBytes / storage.limits.storageLimitBytes) * 100))
    : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" aria-hidden="true" />
          存储用量
        </CardTitle>
        <CardDescription>{loading ? '正在刷新用量' : '当前 Pod 配额视图'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {available ? (
          <>
            <div>
              <div className="text-2xl font-semibold text-foreground">{formatBytes(storage.usage.storageBytes)}</div>
              <div className="text-sm text-muted-foreground">
                {storage.limits.storageLimitBytes == null ? '无存储上限' : `上限 ${formatBytes(storage.limits.storageLimitBytes)}`}
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" aria-label="Storage usage meter">
              <div className="h-full bg-primary" style={{ width: `${percent ?? 0}%` }} />
            </div>
            <div className="grid gap-2 text-sm text-muted-foreground">
              <KeyValue label="入站流量" value={formatBytes(storage.usage.ingressBytes)} />
              <KeyValue label="出站流量" value={formatBytes(storage.usage.egressBytes)} />
              <KeyValue label="带宽" value={storage.limits.bandwidthLimitBps == null ? '不限速' : `${formatBytes(storage.limits.bandwidthLimitBps)}/s`} />
            </div>
          </>
        ) : (
          <StatusMessage
            title={storage?.status === 'error' ? '用量不可用' : '用量暂不支持'}
            detail={storage?.reason ?? 'usage_not_available'}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PodHeader({ title, loading, onRefresh }: { title: string; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-4 px-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">身份、存储与 applet 数据状态</div>
      </div>
      <div className="flex items-center gap-2">
        <a
          className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
          href={title === 'Usage' ? '/settings/pod' : '/dashboard/usage'}
        >
          {title === 'Usage' ? '配置 Pod' : '查看用量'}
        </a>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          刷新
        </Button>
      </div>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="break-words text-sm text-foreground">{value ?? 'Unknown'}</div>
    </div>
  );
}

function StatusMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(amount) ? amount : amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDateTime(value?: string): string {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无记录';
  return date.toLocaleString();
}
