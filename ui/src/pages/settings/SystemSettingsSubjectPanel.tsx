import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@undefineds.co/shared-ui';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { getAdminConfig, getAdminStatus, getDdnsStatus, getProvisionStatus, getPublicIpCheck, resolveAdminAccessBaseUrl, triggerRestart, updateAdminConfig, type AdminConfig, type AdminStatus, type ProvisionStatus, type PublicIpCheckResult } from '../../api/admin';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { AccountPodManagement } from '../../auth/AccountPodManagement';
import { projectStorageBackends, type SettingsEvidenceRow } from './settings-projection';
import { createXpodAiConnectionsClient } from '../../api/ai-connections';
import { createServiceAccessPermissionCapability } from '../../api/service-access-acp';
import { parseAiConnectionsServiceAccess } from '@undefineds.co/ai-connections';

export type SystemSettingsSubjectKind = 'pod' | 'identity-access' | 'storage' | 'runtime' | 'cloud' | 'advanced';

export function PodSettingsSubjectPanel({ kind }: { kind: SystemSettingsSubjectKind }) {
  const runtime = useXpodSolidRuntime();
  const [admin, setAdmin] = useState<AdminStatus | null>(null);
  const [configuration, setConfiguration] = useState<AdminConfig | null>(null);
  const [provision, setProvision] = useState<ProvisionStatus | null>(null);
  const [publicRoute, setPublicRoute] = useState<PublicIpCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applyState, setApplyState] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextAdmin, nextConfig, nextProvision, nextDdns] = await Promise.all([getAdminStatus(), getAdminConfig(), getProvisionStatus(), getDdnsStatus()]);
      if (!nextAdmin || !nextConfig) throw new Error('unavailable');
      setAdmin(nextAdmin); setConfiguration(nextConfig); setProvision(nextProvision);
      setPublicRoute(await getPublicIpCheck(resolveAdminAccessBaseUrl(nextConfig.env, nextDdns, nextAdmin.env.CSS_BASE_URL ?? '')));
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
    {applyState ? <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning dark:bg-warning/20 dark:text-warning"><span>{applyState}</span><Button type="button" size="sm" variant="outline" onClick={() => void triggerRestart()}><RotateCcw className="mr-2 h-4 w-4" />Restart Xpod</Button></div> : null}
    <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{descriptions[kind]}</CardDescription></CardHeader><CardContent className="space-y-4">
      {loading && !configuration ? <div role="status" aria-label="Loading settings" className="grid gap-3 sm:grid-cols-2" aria-live="polite">{[0, 1, 2, 3].map((item) => <div key={item} className="rounded-lg border border-border p-3" aria-hidden="true"><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-5 w-36" /></div>)}</div> : <SubjectContent kind={kind} runtime={runtime} admin={admin} configuration={configuration} provision={provision} publicRoute={publicRoute} save={save} />}
    </CardContent></Card>
  </div>;
}


/**
 * Pod 管理（设计第二部分 §4.1 / U09）：列表、空状态、显式创建。
 *
 * 这里**不**复用 AccountPage 里那套简化的 prepare+POST，而是复用已被守卫的
 * `createFirstPodAndWaitForBinding`（权威清单守卫 + 账号代际守卫 + 精确绑定等待），
 * 保证全仓只有一套创建事务（U04 / U11）。
 */

function SubjectContent({ kind, runtime, admin, configuration, provision, publicRoute, save }: { kind: SystemSettingsSubjectKind; runtime: ReturnType<typeof useXpodSolidRuntime>; admin: AdminStatus | null; configuration: AdminConfig | null; provision: ProvisionStatus | null; publicRoute: PublicIpCheckResult | null; save(patch: Record<string, string>): Promise<void> }) {
  const env = configuration?.env ?? {};
  if (kind === 'pod') {
    return <AccountPodManagement />;
  }
  if (kind === 'identity-access') return <IdentityAccessContent runtime={runtime} />;
  if (kind === 'storage') return <><EvidenceGrid rows={projectStorageBackends(env, configuration?.secrets)} /><p className="text-xs text-muted-foreground">Measured storage and bandwidth are intentionally shown in Status → Usage, not here. Storage migration is unavailable because this runtime does not report a migration capability.</p></>;
  if (kind === 'runtime') {
    // §7.5：服务与访问在同一任务内给出四个主题的状态与去向，配置编辑就在本页
    return (
      <>
        <ServicesAccessSections admin={admin} runtime={runtime} publicRoute={publicRoute} />
        <RuntimeForm env={env} admin={admin} save={save} />
      </>
    );
  }
  if (kind === 'cloud') return <CloudForm env={env} provision={provision} save={save} />;
  return <AdvancedForm env={env} save={save} />;
}

/**
 * 服务与访问的四个主题（spec §7.5）：服务与启动、访问与连接、对外访问设置、诊断。
 * 只呈现读到的状态；读不到就说未知，不显示成 0 或"正常"。
 */
function ServicesAccessSections({
  admin,
  runtime,
  publicRoute,
}: {
  admin: AdminStatus | null;
  runtime: ReturnType<typeof useXpodSolidRuntime>;
  publicRoute: PublicIpCheckResult | null;
}) {
  const serviceState = admin
    ? `${admin.status === 'running' ? '运行中' : admin.status} · 已运行 ${Math.round((admin.uptime ?? 0) / 1000)} 秒`
    : '状态无法确认';
  const accessState = runtime.podUrl
    ? runtime.podUrl
    : runtime.webId ? '已登录，尚未确认存储地址' : '尚未登录';
  const publicState = publicRoute
    ? `${publicRoute.publicIp ?? '公网地址未知'} · ${publicRoute.status === 'pass' ? '可达' : '不可达或未确认'}`
    : '对外访问状态无法确认';

  const sections = [
    {
      id: 'services',
      title: '服务与启动',
      state: serviceState,
      detail: '启动设置就在本页下方；服务明细与日志可直达。',
      links: [
        { label: '服务明细', href: '/status/services/gateway' },
        { label: '日志', href: '/status/logs' },
      ],
    },
    {
      id: 'access',
      title: '访问与连接',
      state: accessState,
      detail: '本机、局域网与外部访问范围在连接页里检测。',
      links: [{ label: '连接与地址', href: '/network' }],
    },
    {
      id: 'public-access',
      title: '对外访问设置',
      state: publicState,
      detail: '域名、HTTPS 与隧道按实际支持的方式配置；切换只保留一条活动隧道。',
      links: [{ label: '打开网络设置', href: '/network' }],
    },
    {
      id: 'diagnostics',
      title: '诊断',
      state: '证据与专业维度',
      detail: '日志、索引与用量都在诊断上下文里，可带对象与筛选进入。',
      links: [
        { label: '索引诊断', href: '/status/index' },
        { label: '用量', href: '/status/usage/overview' },
      ],
    },
  ] as const;

  return (
    <section data-testid="services-access-sections" className="space-y-3">
      <div className="text-sm font-medium">服务与访问</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <div key={section.id} data-testid="services-access-section" data-section={section.id} className="rounded-lg border border-border bg-card p-3">
            <div className="text-sm font-medium">{section.title}</div>
            <div className="mt-1 break-all text-sm text-muted-foreground">{section.state}</div>
            <p className="mt-1 text-xs text-muted-foreground">{section.detail}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              {section.links.map((link) => (
                <a key={link.href} className="text-sm text-primary underline-offset-4 hover:underline" href={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
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
    { label: 'Current account', value: runtime.webId ? podNameLabel(runtime.webId) : 'Signed out' }, { label: 'Session', value: runtime.state.status },
    { label: 'ACP / ACR', value: access === 'error' ? 'Capability unavailable or permission denied' : 'Managed ACR capability available' },
    { label: 'AI Gateway service access', value: accessLabel, detail: 'Inspected from the managed ACRs for declared settings resources' },
  ]} /><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => void inspect()} disabled={access === 'checking'}>Recheck access</Button><Button type="button" variant="destructive" onClick={() => void revoke()} disabled={access !== 'granted' || revoking}>{revoking ? 'Revoking…' : 'Revoke service access'}</Button></div></>;
}

function RuntimeForm({ env, admin, save }: { env: Record<string, string>; admin: AdminStatus | null; save(patch: Record<string, string>): Promise<void> }) {
  // `CSS_BASE_URL` is injected into the running process at startup and is not
  // persisted to the env file, so reading the file alone rendered an empty box
  // and told the operator the instance had no Base URL.
  const effectiveBaseUrl = env.CSS_BASE_URL ?? admin?.env.CSS_BASE_URL ?? '';
  const [baseUrl, setBaseUrl] = useState(effectiveBaseUrl);
  const [dataDir, setDataDir] = useState(env.CSS_ROOT_FILE_PATH ?? '');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setBaseUrl(effectiveBaseUrl);
      setDataDir(env.CSS_ROOT_FILE_PATH ?? '');
    });
    return () => { cancelled = true; };
  }, [env, effectiveBaseUrl]);
  return <div className="space-y-4"><EvidenceGrid rows={[
    { label: 'Edition', value: admin?.env.XPOD_EDITION ?? env.XPOD_EDITION ?? 'local' }, { label: 'Configuration source', value: '.env.local / runtime bootstrap' },
    { label: 'Service startup', value: 'Gateway supervises Solid Server and API Server' }, { label: 'Automatic restart', value: 'Enabled for managed child services' },
  ]} /><div className="grid gap-4 sm:grid-cols-2"><TextInput label="Base URL" value={baseUrl} onChange={setBaseUrl} /><TextInput label="Data directory" value={dataDir} onChange={setDataDir} /></div><SaveButton onClick={() => save({ CSS_BASE_URL: baseUrl, CSS_ROOT_FILE_PATH: dataDir })} /></div>;
}

function CloudForm({ env, provision, save }: { env: Record<string, string>; provision: ProvisionStatus | null; save(patch: Record<string, string>): Promise<void> }) {
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
  return <div className="space-y-4"><EvidenceGrid rows={[
    { label: 'Node registration', value: provision?.registered ? 'Registered' : 'Not registered', detail: provision?.nodeId ?? 'Node ID not reported' },
    { label: 'Cluster coordination', value: provision?.cloudUrl ?? 'Not configured', detail: provision?.managed ? 'This node is cluster-managed' : 'Not cluster-managed' },
    { label: 'Service-provider domain', value: provision?.serviceProviderDomain ?? 'Not allocated' },
  ]} /><div className="grid gap-4 sm:grid-cols-2"><TextInput label="Cloud endpoint" value={endpoint} onChange={setEndpoint} /><TextInput label="Node ID" value={nodeId} onChange={setNodeId} /><TextInput label="Service-provider domain" value={domain} onChange={setDomain} /></div><SaveButton onClick={() => save({ XPOD_CLOUD_API_ENDPOINT: endpoint, XPOD_NODE_ID: nodeId, XPOD_SP_DOMAIN: domain })} /></div>;
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
function podNameLabel(value: string | undefined): string { if (!value) return 'Not discovered'; try { return new URL(value).pathname.split('/').filter(Boolean).at(-1) || new URL(value).hostname; } catch { return value; } }

const titles: Record<SystemSettingsSubjectKind, string> = { pod: 'Pod', 'identity-access': 'Identity & Access', storage: 'Storage', runtime: 'Runtime', cloud: 'Cloud', advanced: 'Advanced' };
const descriptions: Record<SystemSettingsSubjectKind, string> = { pod: 'Current Pod identity and authority boundary.', 'identity-access': 'Session, account, and app/service access.', storage: 'Authority storage backends and health configuration.', runtime: 'Edition, startup, paths, and restart behavior.', cloud: 'Node registration and cluster coordination.', advanced: 'Bounded logging and runtime compatibility controls.' };
