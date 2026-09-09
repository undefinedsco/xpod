import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@undefineds.co/shared-ui';
import { ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import { getAdminConfig, getAdminStatus, triggerRestart, updateAdminConfig, type AdminConfig, type AdminStatus } from '../../api/admin';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { projectStorageBackends, type SettingsEvidenceRow } from './settings-projection';
import { createXpodAiConnectionsClient } from '../../api/ai-connections';
import { createServiceAccessPermissionCapability } from '../../api/service-access-acp';
import { parseAiConnectionsServiceAccess } from '@undefineds.co/ai-connections';

export type SystemSettingsSubjectKind = 'pod' | 'identity-access' | 'storage' | 'runtime' | 'cloud' | 'advanced';

export function PodSettingsSubjectPanel({ kind }: { kind: SystemSettingsSubjectKind }) {
  const runtime = useXpodSolidRuntime();
  const [admin, setAdmin] = useState<AdminStatus | null>(null);
  const [configuration, setConfiguration] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applyState, setApplyState] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextAdmin, nextConfig] = await Promise.all([getAdminStatus(), getAdminConfig()]);
      if (!nextAdmin || !nextConfig) throw new Error('unavailable');
      setAdmin(nextAdmin); setConfiguration(nextConfig);
    } catch { setError('Settings evidence could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => { cancelled = true; };
  }, [load]);

  const save = async (patch: Record<string, string>) => {
    setError('');
    if (!await updateAdminConfig(patch)) { setError('Configuration could not be saved.'); return; }
    setConfiguration((current) => current ? { ...current, env: { ...current.env, ...patch } } : current);
    setApplyState('Saved · restart required');
  };

  const title = titles[kind];
  return <div className="space-y-4 p-6">
    <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
    {error ? <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</div> : null}
    {applyState ? <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200"><span>{applyState}</span><Button type="button" size="sm" variant="outline" onClick={() => void triggerRestart()}><RotateCcw className="mr-2 h-4 w-4" />Restart Xpod</Button></div> : null}
    <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{descriptions[kind]}</CardDescription></CardHeader><CardContent className="space-y-4">
      {loading && !configuration ? <div role="status" aria-label="Loading settings" className="grid gap-3 sm:grid-cols-2" aria-live="polite">{[0, 1, 2, 3].map((item) => <div key={item} className="rounded-lg border border-border p-3" aria-hidden="true"><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-5 w-36" /></div>)}</div> : <SubjectContent kind={kind} runtime={runtime} admin={admin} configuration={configuration} save={save} />}
    </CardContent></Card>
  </div>;
}

function SubjectContent({ kind, runtime, admin, configuration, save }: { kind: SystemSettingsSubjectKind; runtime: ReturnType<typeof useXpodSolidRuntime>; admin: AdminStatus | null; configuration: AdminConfig | null; save(patch: Record<string, string>): Promise<void> }) {
  const env = configuration?.env ?? {};
  if (kind === 'pod') return <><EvidenceGrid rows={[
    { label: 'Pod name', value: podName(runtime.podUrl) }, { label: 'Pod URL', value: runtime.podUrl ?? 'Not discovered' },
    { label: 'Storage provider', value: storageProvider(env) }, { label: 'Created', value: 'Not reported by this runtime' },
  ]} /><Button type="button" variant="outline" disabled={!runtime.podUrl} onClick={() => runtime.podUrl && window.open(runtime.podUrl, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-2 h-4 w-4" />Open Pod</Button></>;
  if (kind === 'identity-access') return <IdentityAccessContent runtime={runtime} />;
  if (kind === 'storage') return <><EvidenceGrid rows={projectStorageBackends(env, configuration?.secrets)} /><p className="text-xs text-muted-foreground">Measured storage and bandwidth are intentionally shown in Status → Usage, not here. Storage migration is unavailable because this runtime does not report a migration capability.</p></>;
  if (kind === 'runtime') return <RuntimeForm env={env} admin={admin} save={save} />;
  if (kind === 'cloud') return <CloudForm env={env} save={save} />;
  return <AdvancedForm env={env} save={save} />;
}

function IdentityAccessContent({ runtime }: { runtime: ReturnType<typeof useXpodSolidRuntime> }) {
  const [access, setAccess] = useState<'checking' | 'granted' | 'missing' | 'unavailable' | 'error'>('checking');
  const [revoking, setRevoking] = useState(false);
  const inspect = useCallback(async () => {
    if (!runtime.webId || !runtime.podUrl || runtime.state.status !== 'authenticated') { setAccess('unavailable'); return; }
    setAccess('checking');
    try {
      const client = createXpodAiConnectionsClient({ webId: runtime.webId, podUrl: runtime.podUrl, authenticatedFetch: runtime.fetch });
      const descriptor = parseAiConnectionsServiceAccess(await client.getServiceAccess(), runtime.podUrl);
      const capability = createServiceAccessPermissionCapability({ authenticatedFetch: runtime.fetch, ownerWebId: runtime.webId });
      const status = await capability.inspectAgentAccess(descriptor);
      setAccess(status.status === 'granted' ? 'granted' : 'missing');
    } catch { setAccess('error'); }
  }, [runtime.fetch, runtime.podUrl, runtime.state.status, runtime.webId]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void inspect();
    });
    return () => { cancelled = true; };
  }, [inspect]);
  const revoke = async () => {
    if (!runtime.webId || !runtime.podUrl || !window.confirm('Revoke AI Gateway service access to Xpod settings resources? Provider credentials remain stored but the service can no longer use them.')) return;
    setRevoking(true);
    try {
      const client = createXpodAiConnectionsClient({ webId: runtime.webId, podUrl: runtime.podUrl, authenticatedFetch: runtime.fetch });
      const descriptor = parseAiConnectionsServiceAccess(await client.getServiceAccess(), runtime.podUrl);
      await createServiceAccessPermissionCapability({ authenticatedFetch: runtime.fetch, ownerWebId: runtime.webId }).revokeAgentAccess(descriptor);
      setAccess('missing');
    } catch { setAccess('error'); }
    finally { setRevoking(false); }
  };
  const accessLabel = access === 'granted' ? 'Granted' : access === 'missing' ? 'Not granted' : access === 'checking' ? 'Checking…' : access === 'unavailable' ? 'Unavailable while signed out' : 'Could not inspect';
  return <><EvidenceGrid rows={[
    { label: 'WebID', value: runtime.webId ?? 'Signed out' }, { label: 'OIDC issuer', value: runtime.issuer ?? 'Not reported' },
    { label: 'Current account', value: runtime.webId ? podName(runtime.webId) : 'Signed out' }, { label: 'Session', value: runtime.state.status },
    { label: 'ACP / ACR', value: access === 'error' ? 'Capability unavailable or permission denied' : 'Managed ACR capability available' },
    { label: 'AI Gateway service access', value: accessLabel, detail: 'Inspected from the managed ACRs for declared settings resources' },
  ]} /><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => void inspect()} disabled={access === 'checking'}>Recheck access</Button><Button type="button" variant="destructive" onClick={() => void revoke()} disabled={access !== 'granted' || revoking}>{revoking ? 'Revoking…' : 'Revoke service access'}</Button></div></>;
}

function RuntimeForm({ env, admin, save }: { env: Record<string, string>; admin: AdminStatus | null; save(patch: Record<string, string>): Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(env.CSS_BASE_URL ?? '');
  const [dataDir, setDataDir] = useState(env.CSS_ROOT_FILE_PATH ?? '');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setBaseUrl(env.CSS_BASE_URL ?? '');
      setDataDir(env.CSS_ROOT_FILE_PATH ?? '');
    });
    return () => { cancelled = true; };
  }, [env]);
  return <div className="space-y-4"><EvidenceGrid rows={[
    { label: 'Edition', value: admin?.env.XPOD_EDITION ?? env.XPOD_EDITION ?? 'local' }, { label: 'Configuration source', value: '.env.local / runtime bootstrap' },
    { label: 'Service startup', value: 'Gateway supervises Solid Server and API Server' }, { label: 'Automatic restart', value: 'Enabled for managed child services' },
  ]} /><div className="grid gap-4 sm:grid-cols-2"><TextInput label="Base URL" value={baseUrl} onChange={setBaseUrl} /><TextInput label="Data directory" value={dataDir} onChange={setDataDir} /></div><SaveButton onClick={() => save({ CSS_BASE_URL: baseUrl, CSS_ROOT_FILE_PATH: dataDir })} /></div>;
}

function CloudForm({ env, save }: { env: Record<string, string>; save(patch: Record<string, string>): Promise<void> }) {
  const [endpoint, setEndpoint] = useState(env.XPOD_CLOUD_API_ENDPOINT ?? '');
  const [nodeId, setNodeId] = useState(env.XPOD_NODE_ID ?? '');
  const [domain, setDomain] = useState(env.XPOD_SP_DOMAIN ?? '');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setEndpoint(env.XPOD_CLOUD_API_ENDPOINT ?? '');
      setNodeId(env.XPOD_NODE_ID ?? '');
      setDomain(env.XPOD_SP_DOMAIN ?? '');
    });
    return () => { cancelled = true; };
  }, [env]);
  return <div className="space-y-4"><EvidenceGrid rows={[{ label: 'Node registration', value: nodeId || 'Not registered' }, { label: 'Heartbeat', value: endpoint ? 'Runtime managed' : 'Not configured' }, { label: 'Cluster coordination', value: endpoint ? 'Configured' : 'Unavailable' }]} /><div className="grid gap-4 sm:grid-cols-2"><TextInput label="Cloud endpoint" value={endpoint} onChange={setEndpoint} /><TextInput label="Node ID" value={nodeId} onChange={setNodeId} /><TextInput label="Service-provider domain" value={domain} onChange={setDomain} /></div><SaveButton onClick={() => save({ XPOD_CLOUD_API_ENDPOINT: endpoint, XPOD_NODE_ID: nodeId, XPOD_SP_DOMAIN: domain })} /></div>;
}

function AdvancedForm({ env, save }: { env: Record<string, string>; save(patch: Record<string, string>): Promise<void> }) {
  const [level, setLevel] = useState(env.CSS_LOGGING_LEVEL ?? 'info');
  const [stack, setStack] = useState(env.CSS_SHOW_STACK_TRACE === 'true');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLevel(env.CSS_LOGGING_LEVEL ?? 'info');
      setStack(env.CSS_SHOW_STACK_TRACE === 'true');
    });
    return () => { cancelled = true; };
  }, [env]);
  return <div className="space-y-4"><EvidenceGrid rows={[{ label: 'Log retention', value: '30 days', detail: 'Runtime logging profile' }, { label: 'Configuration provenance', value: '.env.local allowlist' }, { label: 'Restart requirement', value: 'Required after save' }]} /><label className="block space-y-2 text-sm font-medium">Logging level<select value={level} onChange={(event) => setLevel(event.target.value)} className="block h-10 w-full rounded-md border border-input bg-background px-3 sm:max-w-xs"><option>debug</option><option>info</option><option>warn</option><option>error</option></select></label><label className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm font-medium">Show stack traces<input type="checkbox" checked={stack} onChange={(event) => setStack(event.target.checked)} /></label><SaveButton onClick={() => save({ CSS_LOGGING_LEVEL: level, CSS_SHOW_STACK_TRACE: String(stack) })} /></div>;
}

function EvidenceGrid({ rows }: { rows: SettingsEvidenceRow[] }) { return <div className="grid gap-3 sm:grid-cols-2">{rows.map((row) => <div key={row.label} className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{row.label}</div><div className="mt-1 break-all text-sm font-medium">{row.value}</div>{row.detail ? <div className="mt-1 text-xs text-muted-foreground">{row.detail}</div> : null}</div>)}</div>; }
function TextInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label className="block space-y-2 text-sm font-medium">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className="block h-10 w-full rounded-md border border-input bg-background px-3" /></label>; }
function SaveButton({ onClick }: { onClick(): void }) { return <div className="flex justify-end"><Button type="button" onClick={onClick}>Save configuration</Button></div>; }
function podName(value: string | undefined): string { if (!value) return 'Not discovered'; try { return new URL(value).pathname.split('/').filter(Boolean).at(-1) || new URL(value).hostname; } catch { return value; } }
function storageProvider(env: Record<string, string>): string { return env.MINIO_ENDPOINT || env.XPOD_STORAGE_S3_ENDPOINT ? 'Object storage' : env.CSS_ROOT_FILE_PATH ? 'Filesystem' : 'Runtime default'; }

const titles: Record<SystemSettingsSubjectKind, string> = { pod: 'Pod', 'identity-access': 'Identity & Access', storage: 'Storage', runtime: 'Runtime', cloud: 'Cloud', advanced: 'Advanced' };
const descriptions: Record<SystemSettingsSubjectKind, string> = { pod: 'Current Pod identity and authority boundary.', 'identity-access': 'Session, account, and app/service access.', storage: 'Authority storage backends and health configuration.', runtime: 'Edition, startup, paths, and restart behavior.', cloud: 'Node registration and cluster coordination.', advanced: 'Bounded logging and runtime compatibility controls.' };
