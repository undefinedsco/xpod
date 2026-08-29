import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge, type HealthState } from '@/components/admin/StatusBadge';
import {
  fetchServicesStatusSnapshot,
  resolveAdminAccessBaseUrl,
  type AdminConfig,
  type AdminStatus,
  type DdnsStatus,
  type PublicIpCheckResult,
  type ServicesStatusSnapshot,
  type ServiceState,
} from '@/api/admin';
import { useServicesStatus } from '../settings/services-status-context';

interface RouteRow {
  name: string;
  label: string;
  target: string;
  state: HealthState;
  statusLabel?: string;
  detail: string;
}

interface RuntimeServiceRow {
  name: string;
  state: HealthState;
  detail: string;
  uptime: string;
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

function isLocalAccessUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    if (hostname === 'localhost' || hostname === '::1') return true;
    if (hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
    const private172 = hostname.match(/^172\.(\d+)\./u);
    return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false;
  } catch {
    return false;
  }
}

function RouteSummaryList(props: { routes: RouteRow[] }) {
  return (
    <Card variant="bordered">
      <CardHeader>
        <CardTitle>访问路径</CardTitle>
      </CardHeader>
      <CardContent>
        <div data-testid="runtime-access-path-list" className="divide-y divide-border rounded-xl border border-border">
          {props.routes.map((route) => (
            <div
              key={route.name}
              data-testid="runtime-access-path-row"
              data-route-name={route.name}
              className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">{route.label}</div>
                <div className="mt-1 min-w-0 break-all font-mono text-xs text-muted-foreground" title={route.target}>
                  {route.target}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{route.detail}</div>
              </div>
              <div className="shrink-0 sm:self-start">
                <StatusBadge state={route.state}>{route.statusLabel ?? healthLabel(route.state)}</StatusBadge>
              </div>
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
                  <td className="px-3 py-2 font-medium">{route.label}</td>
                  <td className="px-3 py-2 font-mono text-xs break-all">{route.target}</td>
                  <td className="px-3 py-2"><StatusBadge state={route.state}>{route.statusLabel ?? healthLabel(route.state)}</StatusBadge></td>
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

function ActionNeededCard(props: {
  servicesKnown: boolean;
  servicesHealthy: boolean;
  publicAccessProblem: boolean;
}) {
  if (!props.servicesKnown || (props.servicesHealthy && !props.publicAccessProblem)) {
    return null;
  }

  const servicesFailed = !props.servicesHealthy;
  const title = servicesFailed ? '服务异常' : '外部访问异常';
  const message = servicesFailed
    ? 'Solid Server 或 API Server 未运行，当前无法正常使用 Xpod。请先查看日志。'
    : 'Xpod 在本机运行正常，但从外网暂时无法访问。请检查公网域名、端口映射或用户隧道。';

  return (
    <Card variant="bordered" className="border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-amber-800 dark:text-amber-200">{message}</p>
        {servicesFailed ? (
          <Button variant="secondary" onClick={() => window.location.assign('/status/logs')}>
            查看日志
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => window.location.assign('/network')}>
            打开网络设置
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function StatusPage() {
  const servicesStatus = useServicesStatus();
  const [localServices, setLocalServices] = useState<ServiceState[] | null>(null);
  const [localAdminStatus, setLocalAdminStatus] = useState<AdminStatus | null>(null);
  const [localConfig, setLocalConfig] = useState<AdminConfig | null>(null);
  const [localDdnsStatus, setLocalDdnsStatus] = useState<DdnsStatus | null>(null);
  const [localPublicIpCheck, setLocalPublicIpCheck] = useState<PublicIpCheckResult | null>(null);
  const [localLoading, setLocalLoading] = useState(true);
  const [copyMessage, setCopyMessage] = useState('');
  const [localLoadError, setLocalLoadError] = useState('');
  const [localLastCheckedAt, setLocalLastCheckedAt] = useState<Date | null>(null);

  const applySnapshot = useCallback((snapshot: ServicesStatusSnapshot) => {
    setLocalServices(snapshot.servicesData);
    setLocalAdminStatus(snapshot.adminData);
    setLocalConfig(snapshot.configData);
    setLocalDdnsStatus(snapshot.ddnsData);
    setLocalPublicIpCheck(snapshot.publicCheck);
    setLocalLastCheckedAt(snapshot.checkedAt);
    setLocalLoadError('');
    setLocalLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySnapshot(await fetchServicesStatusSnapshot());
    } catch {
      setLocalLoadError('状态加载失败，请查看日志或稍后刷新。');
      setLocalLoading(false);
    }
  }, [applySnapshot]);

  const refreshWithLoading = useCallback(async () => {
    setLocalLoading(true);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (servicesStatus) return;
    let cancelled = false;
    fetchServicesStatusSnapshot().then((snapshot) => {
      if (!cancelled) {
        applySnapshot(snapshot);
      }
    }).catch(() => {
      if (!cancelled) {
        setLocalLoadError('状态加载失败，请查看日志或稍后刷新。');
        setLocalLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, servicesStatus]);

  const contextSnapshot = servicesStatus?.snapshot;
  const services = contextSnapshot?.servicesData ?? localServices;
  const adminStatus = contextSnapshot?.adminData ?? localAdminStatus;
  const config = contextSnapshot?.configData ?? localConfig;
  const ddnsStatus = contextSnapshot?.ddnsData ?? localDdnsStatus;
  const publicIpCheck = contextSnapshot?.publicCheck ?? localPublicIpCheck;
  const lastCheckedAt = contextSnapshot?.checkedAt ?? localLastCheckedAt;
  const loading = servicesStatus ? servicesStatus.loading && !contextSnapshot : localLoading;
  const loadError = servicesStatus?.error ?? localLoadError;

  const cssService = services?.find((s) => s.name === 'css');
  const apiService = services?.find((s) => s.name === 'api');
  const gatewayState: HealthState = services ? 'healthy' : 'unknown';
  const cssState = serviceHealth(cssService);
  const apiState = serviceHealth(apiService);
  const allServicesRunning = cssState === 'healthy' && apiState === 'healthy';
  const env = config?.env ?? {};
  const tunnelProvider = env.XPOD_TUNNEL_PROVIDER || ddnsStatus?.tunnelProvider || 'none';
  const activeTunnelProfileId = env.XPOD_TUNNEL_ACTIVE_PROFILE_ID || tunnelProvider;
  const baseUrl = resolveAdminAccessBaseUrl(env, ddnsStatus, window.location.origin);
  const localOnlyAccess = isLocalAccessUrl(baseUrl);
  const tunnelUrl = resolveActiveTunnelUrl(env, tunnelProvider, activeTunnelProfileId);

  const routes = useMemo<RouteRow[]>(() => {
    const publicState: HealthState = publicIpCheck?.status === 'pass'
      ? 'healthy'
      : localOnlyAccess
        ? 'unknown'
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
        label: '本机',
        target: `http://127.0.0.1:${env.CSS_PORT || '3000'}`,
        state: serviceRouteState(services, allServicesRunning),
        detail: services ? (allServicesRunning ? '当前设备可以使用。' : '核心服务未运行。') : '正在检查本机服务。',
      },
      {
        name: 'LAN',
        label: '局域网',
        target: ddnsStatus?.ipv4 ? `http://${ddnsStatus.ipv4}:${env.CSS_PORT || '3000'}` : '等待本机地址上报',
        state: ddnsStatus?.ipv4 && allServicesRunning ? 'healthy' : 'unknown',
        detail: ddnsStatus?.ipv4 ? '同一网络中的设备可以使用这个地址。' : '尚未发现局域网地址。',
      },
      {
        name: 'Public',
        label: '公网',
        target: baseUrl,
        state: publicState,
        statusLabel: localOnlyAccess ? '未配置' : undefined,
        detail: localOnlyAccess
          ? '尚未开放公网访问。目前可以在本机或局域网使用。'
          : publicIpCheck?.detail || '尚未检查外网是否可以访问。',
      },
      {
        name: 'User tunnel',
        label: '用户隧道',
        target: tunnelUrl,
        state: userTunnelState,
        statusLabel: tunnelProvider === 'none' ? '未启用' : undefined,
        detail: tunnelProvider === 'none' ? '未启用远程访问隧道。' : `已启用 ${tunnelProvider}。`,
      },
      {
        name: 'P2P backup',
        label: 'P2P 备用',
        target: '信令协调的原生客户端',
        state: 'unknown',
        statusLabel: '备用',
        detail: '备用连接方式，浏览器不会默认使用。',
      },
    ];
  }, [allServicesRunning, baseUrl, ddnsStatus, env.CSS_PORT, localOnlyAccess, publicIpCheck, services, tunnelProvider, tunnelUrl]);

  const publicAccessProblem = !localOnlyAccess && routes.some((route) => (
    (route.name === 'Public' || route.name === 'User tunnel') && route.state === 'failed'
  ));

  const overallState: HealthState = !services
    ? 'unknown'
    : !allServicesRunning
      ? 'failed'
      : publicAccessProblem
        ? 'degraded'
        : 'healthy';
  const recommendedRoute = selectRecommendedRoute(routes);
  const runtimeServices: RuntimeServiceRow[] = [
    {
      name: 'Gateway',
      state: gatewayState,
      detail: services ? '当前控制台可访问' : '等待网关状态上报',
      uptime: lastCheckedAt ? `检查于 ${lastCheckedAt.toLocaleTimeString()}` : '等待检查',
    },
    {
      name: 'Solid Server',
      state: cssState,
      detail: cssService?.pid ? `PID ${cssService.pid}` : 'CSS 请求处理与 Pod 数据服务',
      uptime: formatUptime(cssService?.uptime),
    },
    {
      name: 'API Server',
      state: apiState,
      detail: apiService?.pid ? `PID ${apiService.pid}` : '管理 API 与本机控制能力',
      uptime: formatUptime(apiService?.uptime),
    },
  ];

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
            查看 Xpod 是否正常运行，以及当前可以从哪里访问。
          </p>
        </div>
        <div
          data-testid="status-page-actions"
          className="flex items-center gap-1 self-end lg:shrink-0 lg:self-start"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="刷新状态"
            title="刷新状态"
            onClick={() => servicesStatus ? servicesStatus.refresh() : void refreshWithLoading()}
            disabled={loading || servicesStatus?.refreshing}
          >
            <RefreshCw
              className={`h-4 w-4 ${loading || servicesStatus?.refreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="复制状态 JSON"
            title="复制状态 JSON"
            onClick={() => void copyStatus()}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
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
          <div className="space-y-5">
            <div className="space-y-2">
              <StatusBadge state={overallState}>{healthLabel(overallState)}</StatusBadge>
              <div className="text-2xl font-semibold">Xpod runtime</div>
              <p className="text-sm text-muted-foreground">
                {lastCheckedAt ? `最后检查: ${lastCheckedAt.toLocaleString()}` : '等待第一次检查。'}
              </p>
              <div className="pt-3">
                <div className="text-sm font-medium">稳定资料入口</div>
                <div
                  data-testid="stable-entry-row"
                  className="mt-1 flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/30 p-1 pl-3"
                >
                  <div className="min-w-0 flex-1 break-all font-mono text-sm">
                    {baseUrl || '等待稳定入口'}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="复制入口 URL"
                      title="复制入口 URL"
                      onClick={() => void copyStableUrl()}
                      disabled={!baseUrl}
                    >
                      <Copy className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="打开入口"
                      title="打开入口"
                      onClick={() => window.open(baseUrl, '_blank')}
                      disabled={!baseUrl}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium">当前建议路径</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {recommendedRoute ? `${recommendedRoute.label}: ${recommendedRoute.detail}` : '正在检查可用的访问方式。'}
                </p>
              </div>
            </div>
            <div className="border-t border-border pt-5">
              <div className="mb-3">
                <div className="text-base font-semibold">Services</div>
                <p className="mt-1 text-sm text-muted-foreground">核心运行服务，不包含访问路径或隧道。</p>
              </div>
              <div data-testid="runtime-services-list" className="divide-y divide-border rounded-xl border border-border">
                {runtimeServices.map((service) => (
                  <div
                    key={service.name}
                    data-testid="runtime-service-row"
                    data-service-name={service.name}
                    className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{service.name}</span>
                        <StatusBadge state={service.state}>{healthLabel(service.state)}</StatusBadge>
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">{service.detail}</div>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground sm:text-right">
                      <span className="text-muted-foreground">uptime</span>
                      <span className="ml-2 font-mono">{service.uptime}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <ActionNeededCard servicesKnown={Boolean(services)} servicesHealthy={allServicesRunning} publicAccessProblem={publicAccessProblem} />
      <div data-testid="runtime-access-paths">
        <RouteSummaryList routes={routes} />
      </div>
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
        修改运行方式时，请进入 <Link className="text-primary underline-offset-4 hover:underline" to="/services/configuration">配置</Link>。
      </div>
    </div>
  );
}
