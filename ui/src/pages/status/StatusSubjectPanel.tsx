import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@undefineds.co/shared-ui';
import { ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import {
  fetchServicesStatusSnapshot,
  getLogs,
  restartManagedService,
  triggerRestart,
  type AdminConfig,
  type LogEntry,
  type ServiceState,
} from '../../api/admin';

export function ServiceStatusPanel({ serviceId, title }: { serviceId: 'gateway' | 'css' | 'api'; title: string }) {
  const [service, setService] = useState<ServiceState>();
  const [config, setConfig] = useState<AdminConfig>();
  const [errors, setErrors] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date>();
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [snapshot, logs] = await Promise.all([
        fetchServicesStatusSnapshot({ signal }),
        getLogs({ source: serviceId, level: 'error', limit: 5 }),
      ]);
      setService(serviceId === 'gateway'
        ? { name: 'gateway', status: 'running', pid: snapshot.adminData?.pid, uptime: snapshot.adminData?.uptime ? snapshot.adminData.uptime * 1_000 : undefined, restartCount: 0 }
        : snapshot.servicesData?.find((item) => item.name === serviceId));
      setConfig(snapshot.configData ?? undefined);
      setErrors(logs);
      setLastCheckedAt(snapshot.checkedAt);
      setError(undefined);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError('Service status could not be loaded. The previous snapshot is retained.');
    } finally {
      setLoading(false);
    }
  }, [serviceId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  const metadata = useMemo(() => serviceMetadata(serviceId, config), [config, serviceId]);
  const restart = async () => {
    const scope = serviceId === 'gateway' ? 'the whole Xpod runtime' : `${title} only`;
    if (!window.confirm(`Restart ${scope}? Active requests may be interrupted.`)) return;
    setRestarting(true);
    const ok = serviceId === 'gateway' ? await triggerRestart() : await restartManagedService(serviceId);
    setRestarting(false);
    if (!ok) setError(`Restart request for ${title} was not accepted by this runtime.`);
    else setTimeout(() => void load(), 750);
  };
  return <div className="space-y-4 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div aria-live="polite" className="text-xs text-muted-foreground">{loading ? 'Refreshing service evidence…' : lastCheckedAt ? `Checked ${lastCheckedAt.toLocaleString()}` : 'Not checked'}</div>
      <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
    </div>
    {error && <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</div>}
    <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>Observed state, endpoint, health evidence, dependencies, and explicitly scoped lifecycle action.</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
      <Metric label="State" value={service?.status ?? 'Unknown'} />
      <Metric label="PID" value={service?.pid?.toString() ?? 'Not reported'} />
      <Metric label="Uptime" value={service?.uptime ? formatDuration(service.uptime) : 'Not reported'} />
      <Metric label="Restart count" value={service?.restartCount?.toString() ?? 'Not reported'} />
      <Metric label="Internal endpoint" value={metadata.endpoint} />
      <Metric label="Health check" value={metadata.healthCheck} />
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Dependencies</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm sm:grid-cols-2">{metadata.dependencies.map((item) => <Metric key={item} label={item} value={dependencyState(item, serviceId, service)} />)}</CardContent></Card>
    <Card><CardHeader><CardTitle>Recent errors</CardTitle><CardDescription>Latest supervisor errors scoped to {title}.</CardDescription></CardHeader><CardContent className="space-y-2">
      {errors.length ? errors.map((entry) => <div key={`${entry.timestamp}-${entry.message}`} className="rounded-lg border border-border p-3 text-sm"><div className="text-xs text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</div><div className="mt-1 break-words">{entry.message}</div></div>) : <p className="text-sm text-muted-foreground">No recent errors reported.</p>}
      <a className="inline-flex items-center text-sm font-medium text-primary hover:underline" href={`/status/logs?source=${serviceId}`}><ExternalLink className="mr-1.5 h-4 w-4" />Open related logs</a>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Lifecycle</CardTitle><CardDescription>{serviceId === 'gateway' ? 'Gateway is the parent process, so this action restarts the whole Xpod runtime.' : `This action restarts ${title} only; dependent requests may briefly fail.`}</CardDescription></CardHeader><CardContent><Button type="button" variant="destructive" onClick={() => void restart()} disabled={restarting}><RotateCw className="mr-2 h-4 w-4" />{restarting ? 'Restarting…' : serviceId === 'gateway' ? 'Restart Xpod runtime…' : `Restart ${title}…`}</Button></CardContent></Card>
  </div>;
}

function serviceMetadata(serviceId: 'gateway' | 'css' | 'api', config?: AdminConfig) {
  const env = config?.env ?? {};
  if (serviceId === 'gateway') return { endpoint: window.location.origin, healthCheck: 'GET /service/status', dependencies: ['Solid Server', 'API Server'] };
  if (serviceId === 'css') return { endpoint: env.CSS_INTERNAL_URL || (env.CSS_PORT ? `http://127.0.0.1:${env.CSS_PORT}` : 'Internal endpoint not reported'), healthCheck: 'TCP readiness + Solid root request', dependencies: ['Authority storage', 'Identity service'] };
  return { endpoint: env.API_INTERNAL_URL || (env.API_PORT ? `http://127.0.0.1:${env.API_PORT}` : 'Internal endpoint not reported'), healthCheck: 'GET /health', dependencies: ['Solid Server', 'Configuration store'] };
}

function dependencyState(dependency: string, serviceId: 'gateway' | 'css' | 'api', service?: ServiceState): string {
  if (!service) return 'Not reported';
  if (service.status !== 'running') return `${titleFor(serviceId)} is ${service.status}; dependency health is not implied`;
  return `${dependency} required; direct probe evidence is not reported by this runtime`;
}

function titleFor(serviceId: 'gateway' | 'css' | 'api'): string { return serviceId === 'gateway' ? 'Gateway' : serviceId === 'css' ? 'Solid Server' : 'API Server'; }

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 break-all font-medium">{value}</div></div>;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}
