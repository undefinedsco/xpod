import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge, type HealthState } from '@/components/admin/StatusBadge';
import {
  getAdminConfig,
  getAdminStatus,
  getDdnsStatus,
  getGatewayStatus,
  getPublicIpCheck,
  type AdminConfig,
  type AdminStatus,
  type DdnsStatus,
  type PublicIpCheckResult,
  type ServiceState,
} from '@/api/admin';

interface RouteRow {
  name: string;
  target: string;
  state: HealthState;
  detail: string;
}

interface StatusSnapshot {
  servicesData: ServiceState[] | null;
  adminData: AdminStatus | null;
  configData: AdminConfig | null;
  ddnsData: DdnsStatus | null;
  publicCheck: PublicIpCheckResult | null;
  checkedAt: Date;
}

function fqdnToHttpsUrl(fqdn: string | null | undefined): string {
  if (!fqdn) return '';
  return fqdn.startsWith('http://') || fqdn.startsWith('https://') ? fqdn : `https://${fqdn}/`;
}

function resolveAccessBaseUrl(
  env: Record<string, string>,
  ddnsData: DdnsStatus | null,
  fallback = '',
): string {
  const isManaged = env.XPOD_DEPLOY_MODE !== 'standalone' && Boolean(env.XPOD_CLOUD_API_ENDPOINT);
  if (isManaged) {
    return ddnsData?.baseUrl || fqdnToHttpsUrl(ddnsData?.fqdn) || env.CSS_BASE_URL || fallback;
  }
  return env.CSS_BASE_URL || ddnsData?.baseUrl || fqdnToHttpsUrl(ddnsData?.fqdn) || fallback;
}

function resolveActiveTunnelUrl(env: Record<string, string>, provider: string, activeProfileId: string): string {
  const profileUrl = resolveActiveTunnelProfileUrl(env.XPOD_TUNNEL_PROFILES, activeProfileId);
  if (profileUrl) return profileUrl;

  switch (provider) {
    case 'ngrok': return env.NGROK_URL || '未配置';
    case 'cloudflare': return env.CLOUDFLARE_TUNNEL_URL || env.XPOD_TUNNEL_PUBLIC_URL || '未配置';
    case 'sakura_frp': return env.SAKURA_TUNNEL_URL || env.XPOD_TUNNEL_PUBLIC_URL || '未配置';
    case 'frp': return env.FRP_TUNNEL_URL || '未配置';
    default: return '未配置';
  }
}

function resolveActiveTunnelProfileUrl(rawProfiles: string | undefined, activeProfileId: string): string {
  if (!rawProfiles || !activeProfileId || activeProfileId === 'none') return '';
  try {
    const profiles = JSON.parse(rawProfiles) as unknown;
    if (!Array.isArray(profiles)) return '';
    const profile = profiles.find((item) => {
      return item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).id === activeProfileId;
    }) as Record<string, unknown> | undefined;
    const publicUrl = typeof profile?.publicUrl === 'string' ? profile.publicUrl.trim() : '';
    return publicUrl || '';
  } catch {
    return '';
  }
}

async function loadStatusSnapshot(): Promise<StatusSnapshot> {
  const [servicesData, adminData, configData, ddnsData] = await Promise.all([
    getGatewayStatus(),
    getAdminStatus(),
    getAdminConfig(),
    getDdnsStatus(),
  ]);
  const publicCheck = await getPublicIpCheck(resolveAccessBaseUrl(configData?.env ?? {}, ddnsData));
  return {
    servicesData,
    adminData,
    configData,
    ddnsData,
    publicCheck,
    checkedAt: new Date(),
  };
}

function healthLabel(state: HealthState): string {
  switch (state) {
    case 'healthy': return '可用';
    case 'degraded': return '降级';
    case 'failed': return '失败';
    default: return '未知';
  }
}

function serviceHealth(service: ServiceState | undefined): HealthState {
  if (!service) return 'unknown';
  if (service.status === 'running') return 'healthy';
  if (service.status === 'starting') return 'degraded';
  return 'failed';
}

function serviceRouteState(services: ServiceState[] | null, allServicesRunning: boolean): HealthState {
  if (!services) return 'unknown';
  return allServicesRunning ? 'healthy' : 'failed';
}

function serviceRouteDetail(services: ServiceState[] | null, allServicesRunning: boolean): string {
  if (!services) return '等待服务状态上报。';
  return allServicesRunning ? '本机访问应可用。' : 'CSS 或 API 未运行。';
}

function formatUptime(ms: number | undefined): string {
  if (!ms) return '未知';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function selectRecommendedRoute(routes: RouteRow[]): RouteRow | null {
  const priority = ['Public', 'User tunnel', 'LAN', 'Loopback'];
  return priority
    .map((name) => routes.find((route) => route.name === name && route.state === 'healthy'))
    .find((route): route is RouteRow => Boolean(route))
    ?? routes.find((route) => route.state === 'degraded')
    ?? routes.find((route) => route.state === 'unknown')
    ?? null;
}

function RouteSummaryCards(props: { routes: RouteRow[] }) {
  return (
    <Card variant="bordered">
      <CardHeader>
        <CardTitle>访问路径</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {props.routes.map((route) => (
            <div key={route.name} className="min-w-0 rounded-xl border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{route.name}</span>
                <StatusBadge state={route.state}>{healthLabel(route.state)}</StatusBadge>
              </div>
              <div className="mt-2 min-w-0 break-all font-mono text-xs text-muted-foreground" title={route.target}>
                {route.target}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{route.detail}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RouteTable(props: { routes: RouteRow[] }) {
  return (
    <Card variant="bordered">
      <CardHeader>
        <CardTitle>完整路径详情</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">路径</th>
                <th className="px-3 py-2 text-left font-medium">目标</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">证据</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {props.routes.map((route) => (
                <tr key={route.name}>
                  <td className="px-3 py-2 font-medium">{route.name}</td>
                  <td className="px-3 py-2 font-mono text-xs break-all">{route.target}</td>
                  <td className="px-3 py-2"><StatusBadge state={route.state}>{healthLabel(route.state)}</StatusBadge></td>
                  <td className="px-3 py-2 text-muted-foreground">{route.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ActionNeededCard(props: { state: HealthState; routes: RouteRow[] }) {
  if (props.state === 'healthy' || props.state === 'unknown') {
    return null;
  }

  const failedRoute = props.routes.find((route) => route.state === 'failed' || route.state === 'degraded');
  const message = failedRoute
    ? `${failedRoute.name} 当前不可用。${failedRoute.detail}`
    : '运行时状态还没有完整上报，请刷新或查看日志。';

  return (
    <Card variant="bordered" className="border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
      <CardHeader>
        <CardTitle>需要处理</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-amber-800 dark:text-amber-200">{message}</p>
        <Button variant="secondary" onClick={() => window.location.assign('/dashboard/logs')}>
          打开日志
        </Button>
      </CardContent>
    </Card>
  );
}

export function StatusPage() {
  const [services, setServices] = useState<ServiceState[] | null>(null);
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [ddnsStatus, setDdnsStatus] = useState<DdnsStatus | null>(null);
  const [publicIpCheck, setPublicIpCheck] = useState<PublicIpCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyMessage, setCopyMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  const applySnapshot = useCallback((snapshot: StatusSnapshot) => {
    setServices(snapshot.servicesData);
    setAdminStatus(snapshot.adminData);
    setConfig(snapshot.configData);
    setDdnsStatus(snapshot.ddnsData);
    setPublicIpCheck(snapshot.publicCheck);
    setLastCheckedAt(snapshot.checkedAt);
    setLoadError('');
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySnapshot(await loadStatusSnapshot());
    } catch {
      setLoadError('状态加载失败，请查看日志或稍后刷新。');
      setLoading(false);
    }
  }, [applySnapshot]);

  const refreshWithLoading = useCallback(async () => {
    setLoading(true);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    loadStatusSnapshot().then((snapshot) => {
      if (!cancelled) {
        applySnapshot(snapshot);
      }
    }).catch(() => {
      if (!cancelled) {
        setLoadError('状态加载失败，请查看日志或稍后刷新。');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applySnapshot]);

  const cssService = services?.find((s) => s.name === 'css');
  const apiService = services?.find((s) => s.name === 'api');
  const gatewayState: HealthState = services ? 'healthy' : 'unknown';
  const cssState = serviceHealth(cssService);
  const apiState = serviceHealth(apiService);
  const allServicesRunning = cssState === 'healthy' && apiState === 'healthy';
  const env = config?.env ?? {};
  const tunnelProvider = env.XPOD_TUNNEL_PROVIDER || ddnsStatus?.tunnelProvider || 'none';
  const activeTunnelProfileId = env.XPOD_TUNNEL_ACTIVE_PROFILE_ID || tunnelProvider;
  const baseUrl = resolveAccessBaseUrl(env, ddnsStatus, window.location.origin);
  const tunnelUrl = resolveActiveTunnelUrl(env, tunnelProvider, activeTunnelProfileId);

  const routes = useMemo<RouteRow[]>(() => {
    const publicState: HealthState = publicIpCheck?.status === 'pass'
      ? 'healthy'
      : publicIpCheck?.status === 'fail'
        ? 'failed'
        : 'unknown';
    const userTunnelState: HealthState = tunnelProvider === 'none'
      ? 'unknown'
      : ddnsStatus?.mode === 'tunnel' || tunnelUrl !== '未配置'
        ? 'healthy'
        : 'degraded';

    return [
      {
        name: 'Loopback',
        target: `http://127.0.0.1:${env.CSS_PORT || '3000'}`,
        state: serviceRouteState(services, allServicesRunning),
        detail: serviceRouteDetail(services, allServicesRunning),
      },
      {
        name: 'LAN',
        target: ddnsStatus?.ipv4 ? `http://${ddnsStatus.ipv4}:${env.CSS_PORT || '3000'}` : '等待本机地址上报',
        state: ddnsStatus?.ipv4 && allServicesRunning ? 'healthy' : 'unknown',
        detail: ddnsStatus?.ipv4 ? '局域网设备可尝试该地址。' : '运行时还没有上报局域网地址。',
      },
      {
        name: 'Public',
        target: baseUrl,
        state: publicState,
        detail: publicIpCheck?.detail || '公网可达性尚未检测。',
      },
      {
        name: 'User tunnel',
        target: tunnelUrl,
        state: userTunnelState,
        detail: tunnelProvider === 'none' ? '未启用用户隧道。' : `当前供应商: ${tunnelProvider}`,
      },
      {
        name: 'P2P backup',
        target: '信令协调的原生客户端',
        state: 'unknown',
        detail: 'P2P 只作为免配置备选路径，不作为浏览器默认入口。',
      },
    ];
  }, [activeTunnelProfileId, allServicesRunning, baseUrl, ddnsStatus, env.CSS_PORT, publicIpCheck, services, tunnelProvider, tunnelUrl]);

  const overallState: HealthState = !services
    ? 'unknown'
    : !allServicesRunning
      ? 'failed'
      : routes.some((route) => route.state === 'failed')
        ? 'degraded'
        : 'healthy';
  const recommendedRoute = selectRecommendedRoute(routes);

  const copyStatus = async () => {
    const payload = {
      lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
      services,
      adminStatus,
      ddnsStatus,
      publicIpCheck,
      routes,
      stableDataUrl: baseUrl,
      recommendedRoute,
      sanitizedConfig: config ? { env: config.env, secrets: config.secrets ?? {} } : null,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopyMessage('状态 JSON 已复制');
  };

  const copyStableUrl = async () => {
    await navigator.clipboard.writeText(baseUrl);
    setCopyMessage('稳定资料入口已复制');
  };

  return (
    <div className="p-4 sm:p-8 max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="type-h1">状态</h1>
          <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
            查看服务是否运行、资料路径是否稳定，以及外部访问失败时需要处理什么。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void refreshWithLoading()} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button variant="secondary" onClick={() => void copyStatus()} className="gap-2">
            <Copy className="h-4 w-4" />
            复制状态 JSON
          </Button>
          <Button onClick={() => window.open(baseUrl, '_blank')} className="gap-2">
            <ExternalLink className="h-4 w-4" />
            打开入口
          </Button>
        </div>
      </div>

      {copyMessage ? <p className="text-sm text-green-700 dark:text-green-300">{copyMessage}</p> : null}
      {loadError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </div>
      ) : null}

      <Card variant="bordered">
        <CardContent className="pt-5">
          <div className="grid gap-5 lg:grid-cols-[1fr_1.5fr]">
            <div className="space-y-2">
              <StatusBadge state={overallState}>{healthLabel(overallState)}</StatusBadge>
              <div className="text-2xl font-semibold">Xpod runtime</div>
              <p className="text-sm text-muted-foreground">
                {lastCheckedAt ? `最后检查: ${lastCheckedAt.toLocaleString()}` : '等待第一次检查。'}
              </p>
              <div className="pt-3">
                <div className="text-sm font-medium">稳定资料入口</div>
                <div className="mt-1 break-all rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                  {baseUrl || '等待稳定入口'}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium">当前建议路径</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {recommendedRoute ? `${recommendedRoute.name}: ${recommendedRoute.detail}` : '等待访问路径检测。'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => void copyStableUrl()} disabled={!baseUrl}>
                  复制 URL
                </Button>
                <Button size="sm" onClick={() => window.open(baseUrl, '_blank')} disabled={!baseUrl}>
                  打开入口
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['Gateway', gatewayState, '当前控制台可访问'],
                ['CSS', cssState, formatUptime(cssService?.uptime)],
                ['API', apiState, formatUptime(apiService?.uptime)],
                ['Tunnel', tunnelProvider === 'none' ? 'unknown' : 'healthy', tunnelProvider],
              ].map(([name, state, detail]) => (
                <div key={name} className="rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{name}</span>
                    <StatusBadge state={state as HealthState}>{healthLabel(state as HealthState)}</StatusBadge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <ActionNeededCard state={overallState} routes={routes} />
      <RouteSummaryCards routes={routes} />
      <RouteTable routes={routes} />

      <Card variant="bordered">
        <CardHeader><CardTitle>Cloud 协调</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">nodeId</span><span className="font-mono break-all">{env.XPOD_NODE_ID || '未上报'}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">spDomain</span><span className="font-mono break-all">{env.XPOD_SP_DOMAIN || ddnsStatus?.fqdn || '未分配'}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">DDNS</span><span>{ddnsStatus?.detail || '未上报'}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">heartbeat</span><span>{ddnsStatus?.enabled ? '已启用' : '未启用或未上报'}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">模式</span><span>{ddnsStatus?.mode || 'unknown'}</span></div>
          <p className="pt-2 text-muted-foreground">Cloud 负责稳定域名和 IDP，本地 SP 负责数据存储与实际接入。</p>
        </CardContent>
      </Card>

      <Card variant="bordered" className="bg-muted/30">
        <CardHeader><CardTitle>配置摘要</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">edition</span><span>{adminStatus?.env.XPOD_EDITION || 'local'}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">baseUrl</span><span className="font-mono break-all">{baseUrl}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">storage</span><span className="font-mono break-all">{env.CSS_ROOT_FILE_PATH || './data'}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">provider</span><span>{tunnelProvider}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">tunnelProfile</span><span>{activeTunnelProfileId}</span></div>
          <div className="grid grid-cols-[140px_1fr] gap-2"><span className="text-muted-foreground">secrets</span><span>{Object.entries(config?.secrets ?? {}).filter(([, value]) => value.configured).length} 个已配置</span></div>
        </CardContent>
      </Card>

      <div className="text-sm text-muted-foreground">
        需要修改运行时配置时进入 <Link className="text-primary underline-offset-4 hover:underline" to="/settings">设置</Link>。
      </div>
    </div>
  );
}
