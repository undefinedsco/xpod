import { useEffect, useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { fetchPodSettingsStatus, type PodStorageStatus } from '../../api/pod-settings';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { formatBytes, formatLimit, formatSeconds } from './usage-format';

/**
 * 用量页（spec §3.1 的 `/status/usage/*`、§7.2、AC-09）。
 *
 * 只呈现读到的数字：`unsupported` 说明部署不支持、读取失败说"状态无法确认"，
 * 都不回落成 0；真的 0 才显示 0。
 */
export type UsageKind = 'overview' | 'storage' | 'bandwidth' | 'ai' | 'index-storage';

const KIND_TITLES: Record<UsageKind, string> = {
  overview: '用量',
  storage: '存储用量',
  bandwidth: '带宽用量',
  ai: 'AI 用量',
  'index-storage': '索引占用',
};

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div data-testid="usage-fact" data-fact-label={label} className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-all text-sm">{value}</div>
    </div>
  );
}

export function UsagePage({ kind = 'overview' }: { kind?: UsageKind }) {
  const runtime = useXpodSolidRuntime();
  const [storage, setStorage] = useState<PodStorageStatus | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!runtime.webId || !runtime.podUrl) {
      setStorage({ status: 'error', reason: '尚未确认当前 WebID 与存储空间。' });
      return;
    }
    let cancelled = false;
    setStorage(null);
    void fetchPodSettingsStatus({
      webId: runtime.webId,
      podUrl: runtime.podUrl,
      authenticatedFetch: runtime.fetch,
    })
      .then((status) => {
        if (cancelled) return;
        setGeneratedAt(status.generatedAt);
        setStorage(status.storage);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStorage({ status: 'error', reason: error instanceof Error ? error.message : '读取失败' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runtime.webId, runtime.podUrl, runtime.fetch, reloadToken]);

  const title = KIND_TITLES[kind];

  if (storage === null) {
    return (
      <div className="p-4 sm:p-8 max-w-6xl space-y-6">
        <h1 className="type-h1">{title}</h1>
        <div role="status" className="text-sm text-muted-foreground">正在读取用量…</div>
      </div>
    );
  }

  if (storage.status !== 'available') {
    const unsupported = storage.status === 'unsupported';
    return (
      <div className="p-4 sm:p-8 max-w-6xl space-y-6">
        <h1 className="type-h1">{title}</h1>
        <Card variant="bordered">
          <CardContent className="space-y-2 pt-5 text-sm">
            {/* AC-09：未知/不支持都不得显示成 0 */}
            <div data-testid="usage-state" data-usage-state={storage.status} className="font-medium">
              {unsupported ? '此部署不提供用量数据' : '状态无法确认'}
            </div>
            {storage.reason ? <p className="text-muted-foreground">{storage.reason}</p> : null}
            {unsupported ? null : (
              <button
                type="button"
                className="text-primary underline-offset-4 hover:underline"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                重新读取
              </button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const { usage, limits } = storage;
  const show = (section: 'storage' | 'bandwidth' | 'ai') => kind === 'overview' || kind === section
    || (kind === 'index-storage' && section === 'storage');

  return (
    <div className="p-4 sm:p-8 max-w-6xl space-y-6">
      <div>
        <h1 className="type-h1">{title}</h1>
        <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
          {storage.source ? `来源：${storage.source}` : '来源：当前存储空间的用量记录'}
        </p>
      </div>

      {kind === 'index-storage' ? (
        <Card variant="bordered">
          <CardContent className="pt-5 text-sm text-muted-foreground">
            索引占用尚无独立数据来源；当前只能看到存储空间的总用量。
          </CardContent>
        </Card>
      ) : null}

      {show('storage') ? (
        <Card variant="bordered">
          <CardHeader><CardTitle>存储</CardTitle></CardHeader>
          <CardContent>
            <div data-testid="usage-storage" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="已用" value={formatBytes(usage.storageBytes)} />
            <Fact label="存储上限" value={formatLimit(limits.storageLimitBytes, formatBytes)} />
            <Fact label="记录时间" value={generatedAt ?? '未标注'} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {show('bandwidth') ? (
        <Card variant="bordered">
          <CardHeader><CardTitle>带宽</CardTitle></CardHeader>
          <CardContent>
            <div data-testid="usage-bandwidth" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="入站" value={formatBytes(usage.ingressBytes)} />
            <Fact label="出站" value={formatBytes(usage.egressBytes)} />
            <Fact
              label="带宽上限"
              value={formatLimit(limits.bandwidthLimitBps, (limit) => `${formatBytes(limit)}/s`)}
            />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {show('ai') ? (
        <Card variant="bordered">
          <CardHeader><CardTitle>AI</CardTitle></CardHeader>
          <CardContent>
            <div data-testid="usage-ai" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="计算时长" value={formatSeconds(usage.computeSeconds)} />
            <Fact label="计算上限" value={formatLimit(limits.computeLimitSeconds, formatSeconds)} />
            <Fact label="本月 tokens" value={String(usage.tokensUsed)} />
            <Fact label="tokens 上限" value={formatLimit(limits.tokenLimitMonthly, (limit) => String(limit))} />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
