import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TwoPaneLayout, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, toast } from '@undefineds.co/shared-ui';
import { Activity, Copy, Download, ExternalLink, Globe2, Network, RefreshCw, RotateCcw, ShieldCheck, Wifi } from 'lucide-react';
import {
  fetchNetworkSettingsStatus,
  updateNetworkConfiguration,
  renewNetworkCertificate,
  runNetworkDiagnostics,
  type NetworkDiagnosticCheckResult,
  type NetworkSettingsStatus,
  type NetworkConfigurationPatch,
  type NetworkDesiredConfiguration,
} from '../../api/network-settings';
import { PaneListHeader } from './PaneListHeader';
import { networkNavigationItems } from '../../layout/network-navigation';
import { getListNavItemClass } from '../../layout/nav-item-style';
import { formatNetworkDiagnosticReport } from './network-diagnostic-report';
import { handleListNavigationKeyDown } from '../../layout/list-keyboard-navigation';

export default function NetworkPage() {
  const [status, setStatus] = useState<NetworkSettingsStatus>();
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnosticCheckResult[]>([]);
  const [diagnosticsCheckedAt, setDiagnosticsCheckedAt] = useState<Date>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [configurationApplyState, setConfigurationApplyState] = useState<string>();
  const requestIdRef = useRef(0);
  const diagnoseActionIdRef = useRef(0);
  const renewActionIdRef = useRef(0);
  const activeIdentityKeyRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const localOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  const networkBaseUrl = localOrigin;
  const identityKey = networkBaseUrl ? `local-host:${networkBaseUrl}` : undefined;
  // Network is a host capability, not a Solid resource. Loopback authorization
  // is verified by the API/Gateway transport and must never depend on or mutate
  // the independently restored WebID session.
  const hostFetch = globalThis.fetch;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      diagnoseActionIdRef.current += 1;
      renewActionIdRef.current += 1;
    };
  }, []);

  const isCurrentRequest = useCallback((requestId: number, requestIdentityKey: string) => (
    mountedRef.current
    && requestIdRef.current === requestId
    && activeIdentityKeyRef.current === requestIdentityKey
  ), []);

  const isCurrentDiagnoseAction = useCallback((actionId: number, requestIdentityKey: string) => (
    mountedRef.current
    && diagnoseActionIdRef.current === actionId
    && activeIdentityKeyRef.current === requestIdentityKey
  ), []);

  const isCurrentRenewAction = useCallback((actionId: number, requestIdentityKey: string) => (
    mountedRef.current
    && renewActionIdRef.current === actionId
    && activeIdentityKeyRef.current === requestIdentityKey
  ), []);

  const loadStatus = useCallback(async () => {
    const requestIdentityKey = identityKey;
    if (!requestIdentityKey) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setError(undefined);
    try {
      const nextStatus = await fetchNetworkSettingsStatus({
        fetchImpl: hostFetch,
      });
      if (isCurrentRequest(requestId, requestIdentityKey)) {
        setStatus(nextStatus);
      }
    } catch {
      if (isCurrentRequest(requestId, requestIdentityKey)) {
        setError('网络设置请求失败，请重试。');
      }
    } finally {
      if (isCurrentRequest(requestId, requestIdentityKey)) {
        setLoading(false);
      }
    }
  }, [hostFetch, identityKey, isCurrentRequest]);

  useEffect(() => {
    let cancelled = false;
    activeIdentityKeyRef.current = identityKey;
    requestIdRef.current += 1;
    diagnoseActionIdRef.current += 1;
    renewActionIdRef.current += 1;
    queueMicrotask(() => {
      if (cancelled || activeIdentityKeyRef.current !== identityKey) return;
      setStatus(undefined);
      setDiagnostics([]);
      setDiagnosticsCheckedAt(undefined);
      setError(undefined);
      setLoading(false);
      setDiagnosing(false);
      setRenewing(false);
      if (identityKey) {
        void loadStatus();
      }
    });
    return () => { cancelled = true; };
  }, [identityKey, loadStatus]);

  const runDiagnose = useCallback(async () => {
    const requestIdentityKey = identityKey;
    if (!requestIdentityKey) return;
    const actionId = diagnoseActionIdRef.current + 1;
    diagnoseActionIdRef.current = actionId;
    setDiagnosing(true);
    setError(undefined);
    try {
      const result = await runNetworkDiagnostics({
        fetchImpl: hostFetch,
      });
      if (isCurrentDiagnoseAction(actionId, requestIdentityKey)) {
        setDiagnostics(result.checks);
        setDiagnosticsCheckedAt(new Date());
        toast({ description: '诊断完成' });
      }
    } catch {
      if (isCurrentDiagnoseAction(actionId, requestIdentityKey)) {
        setError('网络诊断失败，请重试。');
      }
    } finally {
      if (isCurrentDiagnoseAction(actionId, requestIdentityKey)) {
        setDiagnosing(false);
      }
    }
  }, [hostFetch, identityKey, isCurrentDiagnoseAction]);

  const renewCertificate = useCallback(async () => {
    const requestIdentityKey = identityKey;
    if (!requestIdentityKey) return;
    const actionId = renewActionIdRef.current + 1;
    renewActionIdRef.current = actionId;
    setRenewing(true);
    setError(undefined);
    try {
      await renewNetworkCertificate({
        fetchImpl: hostFetch,
      });
      if (isCurrentRenewAction(actionId, requestIdentityKey)) {
        toast({ variant: 'success', description: '证书续签成功' });
        await loadStatus();
      }
    } catch {
      if (isCurrentRenewAction(actionId, requestIdentityKey)) {
        setError('证书续签失败，请重试。');
      }
    } finally {
      if (isCurrentRenewAction(actionId, requestIdentityKey)) {
        setRenewing(false);
      }
    }
  }, [hostFetch, identityKey, isCurrentRenewAction, loadStatus]);

  const saveConfiguration = useCallback(async (patch: NetworkConfigurationPatch) => {
    if (!networkBaseUrl) return;
    setSavingConfiguration(true);
    setError(undefined);
    try {
      const result = await updateNetworkConfiguration({ fetchImpl: hostFetch, patch });
      setStatus((current) => current ? { ...current, configuration: result.configuration } : current);
      setConfigurationApplyState(result.applyState);
      toast({ variant: 'success', description: 'Network configuration saved' });
    } catch {
      setError('网络配置保存失败，请重试。');
    } finally {
      setSavingConfiguration(false);
    }
  }, [hostFetch, networkBaseUrl]);

  const sections = useMemo(() => [
    { key: 'local', title: '本机', values: status?.addresses.local ?? [] },
    { key: 'lan', title: '局域网', values: status?.addresses.lan ?? [] },
    { key: 'public', title: '公网', values: status?.addresses.public ?? [] },
  ], [status]);
  const sectionId = typeof window === 'undefined' ? undefined : window.location.pathname.split('/').filter(Boolean).at(-1);
  const activeSection = networkNavigationItems.some((item) => item.path === sectionId) ? sectionId : 'overview';

  return (
    <TwoPaneLayout
      mode="auto"
      listHeader={<PaneListHeader title="Network" />}
      list={<NetworkList />}
      mainHeader={<NetworkHeader title={networkNavigationItems.find((item) => (item.path || 'overview') === activeSection)?.label ?? 'Overview'} loading={loading} stale={loading && Boolean(status)} onRefresh={loadStatus} />}
      main={
        <section className="flex min-h-full flex-col gap-4 bg-background p-6">
          {error ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {(activeSection === 'overview' || activeSection === 'endpoints') && <EndpointCard endpoint={status?.endpoint} loading={loading && !status} />}
          {activeSection === 'overview' && <NetworkOverviewCard status={status} />}
          {(activeSection === 'overview' || activeSection === 'addresses') && <AddressCard sections={sections} loading={loading && !status} diagnostics={diagnostics} checkedAt={diagnosticsCheckedAt} />}
          {activeSection === 'overview' && <CapabilityCard status={status} />}
          {activeSection === 'domain-dns' && <><ObservedDnsCard status={status} /><DnsConfigurationCard configuration={status?.configuration} saving={savingConfiguration} applyState={configurationApplyState} onSave={saveConfiguration} /></>}
          {activeSection === 'https' && <><ObservedTlsCard status={status} /><HttpsConfigurationCard configuration={status?.configuration} saving={savingConfiguration} applyState={configurationApplyState} onSave={saveConfiguration} /></>}
          {activeSection === 'tunnel-profiles' && <><SingleCapabilityCard title="Observed tunnel" label="Tunnel" capability={status?.tunnel} /><TunnelConfigurationCard configuration={status?.configuration} saving={savingConfiguration} applyState={configurationApplyState} onSave={saveConfiguration} /></>}
          {activeSection === 'p2p' && <P2pConfigurationCard configuration={status?.configuration} saving={savingConfiguration} applyState={configurationApplyState} onSave={saveConfiguration} />}
          {(activeSection === 'overview' || activeSection === 'diagnostics' || activeSection === 'https') && <ActionsCard
            status={status}
            endpoint={status?.endpoint}
            diagnostics={diagnostics}
            diagnosing={diagnosing}
            renewing={renewing}
            onDiagnose={runDiagnose}
            onRenewCertificate={renewCertificate}
          />}
        </section>
      }
      className="min-h-full"
    />
  );
}

function NetworkList() {
  const workspace = useWorkspaceLayout();
  return <aside className="h-full border-r border-border bg-muted/20 py-2"><nav aria-label="Network sections" data-list-navigation>
    {networkNavigationItems.map((item) => {
      const Icon = item.icon;
      const to = `/network${item.path ? `/${item.path}` : ''}`;
      const current = typeof window !== 'undefined' ? window.location.pathname.replace(/\/$/, '') : '';
      const active = current === to;
      return <a
        key={item.id}
        href={to}
        onClick={() => workspace.openMain()}
        onKeyDown={handleListNavigationKeyDown}
        aria-current={active ? 'page' : undefined}
        className={getListNavItemClass(active, { compact: false })}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />{item.label}
      </a>;
    })}
  </nav></aside>;
}

function NetworkHeader({ title, loading, stale, onRefresh }: { title: string; loading: boolean; stale: boolean; onRefresh: () => void }) {
  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-4 px-4">
      <div className="min-w-0">
        <h1 className="text-sm font-semibold text-foreground">Network · {title}</h1>
        <div className="truncate text-xs text-muted-foreground" aria-live="polite">
          {stale ? 'Refreshing · showing previous snapshot' : '接入点、DNS、TLS、隧道与连通性诊断'}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          刷新
        </Button>
      </div>
    </div>
  );
}

function NetworkOverviewCard({ status }: { status?: NetworkSettingsStatus }) {
  const recommended = status?.addresses.public[0] ?? status?.addresses.lan[0] ?? status?.addresses.local[0] ?? status?.endpoint;
  const nextAction = !status
    ? 'Refresh network status.'
    : !status.dns.supported || status.dns.status === 'unsupported'
      ? 'Configure Domain & DNS, then recheck observed DNS.'
      : !status.tls.supported || !['valid', 'active', 'ready'].includes(status.tls.status)
        ? 'Review HTTPS configuration and certificate renewal evidence.'
        : 'No connectivity action is currently required.';
  return <Card><CardHeader><CardTitle className="text-base">Recommended access path</CardTitle><CardDescription>Chosen from observed public, LAN, then local reachability</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><div className="break-words font-medium">{recommended ?? 'Unavailable'}</div><div className="grid gap-2 sm:grid-cols-4"><Badge variant="outline">Local {status?.addresses.local.length ? 'available' : 'unavailable'}</Badge><Badge variant="outline">LAN {status?.addresses.lan.length ? 'available' : 'unavailable'}</Badge><Badge variant="outline">Public {status?.addresses.public.length ? 'available' : 'unavailable'}</Badge><Badge variant="outline">Tunnel {status?.tunnel.status ?? 'unknown'}</Badge></div><div className="rounded-md border border-border bg-muted/30 p-3"><div className="font-medium">Next action</div><div className="mt-1 text-muted-foreground">{nextAction}</div></div></CardContent></Card>;
}

function SingleCapabilityCard({ title, label, capability, extra }: { title: string; label: string; capability?: { supported: boolean; status: string }; extra?: string }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>Observed runtime state</CardDescription></CardHeader><CardContent><CapabilityRow label={label} capability={capability} extra={extra} /></CardContent></Card>;
}

function UnavailableConfiguration({ title }: { title: string }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>Desired configuration</CardDescription></CardHeader><CardContent className="text-sm text-muted-foreground">This runtime does not report a configurable {title} capability.</CardContent></Card>;
}

function DnsConfigurationCard({ configuration, saving, applyState, onSave }: ConfigurationCardProps) {
  const [value, setValue] = useState(configuration?.domainDns);
  const [credential, setCredential] = useState('');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setValue(configuration?.domainDns);
    });
    return () => { cancelled = true; };
  }, [configuration]);
  if (!value) return <UnavailableConfiguration title="Domain & DNS" />;
  return <ConfigurationCard title="Saved configuration" applyState={applyState}>
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField name="domain" label="Domain" value={value.domain} onChange={(domain) => setValue({ ...value, domain })} />
      <TextField name="provider" label="DNS provider" value={value.provider} onChange={(provider) => setValue({ ...value, provider })} />
      <NumberField name="recordTtl" label="Record TTL (seconds)" value={value.recordTtl} min={30} max={86400} onChange={(recordTtl) => setValue({ ...value, recordTtl })} />
      <TextField name="dnsCredential" label={value.credentialConfigured ? 'Replace credential (configured)' : 'Credential'} value={credential} type="password" onChange={setCredential} />
    </div>
    <ToggleField label="Enable DDNS" checked={value.ddnsEnabled} onChange={(ddnsEnabled) => setValue({ ...value, ddnsEnabled })} />
    <SaveConfigurationButton label="Save DNS configuration" saving={saving} onClick={() => onSave({ domainDns: { domain: value.domain, ddnsEnabled: value.ddnsEnabled, provider: value.provider, recordTtl: value.recordTtl, ...(credential ? { credential } : {}) } })} />
  </ConfigurationCard>;
}

function HttpsConfigurationCard({ configuration, saving, applyState, onSave }: ConfigurationCardProps) {
  const [value, setValue] = useState(configuration?.https);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setValue(configuration?.https);
    });
    return () => { cancelled = true; };
  }, [configuration]);
  if (!value) return <UnavailableConfiguration title="HTTPS" />;
  return <ConfigurationCard title="Saved configuration" applyState={applyState}>
    <ToggleField label="Enable HTTPS" checked={value.enabled} onChange={(enabled) => setValue({ ...value, enabled })} />
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField name="acmeEmail" label="ACME email" value={value.acmeEmail} onChange={(acmeEmail) => setValue({ ...value, acmeEmail })} />
      <TextField name="acmeDomains" label="Certificate domains" value={value.domains.join(', ')} onChange={(domains) => setValue({ ...value, domains: domains.split(',').map((item) => item.trim()).filter(Boolean) })} />
      <TextField name="certificatePath" label="Certificate path" value={value.certificatePath ?? ''} onChange={(certificatePath) => setValue({ ...value, certificatePath })} />
      <TextField name="certificateKeyPath" label="Private-key path" value={value.certificateKeyPath ?? ''} onChange={(certificateKeyPath) => setValue({ ...value, certificateKeyPath })} />
      <NumberField name="renewBeforeDays" label="Renew before (days)" value={value.renewBeforeDays} min={1} max={90} onChange={(renewBeforeDays) => setValue({ ...value, renewBeforeDays })} />
    </div>
    <SaveConfigurationButton label="Save HTTPS configuration" saving={saving} onClick={() => onSave({ https: value })} />
  </ConfigurationCard>;
}

function TunnelConfigurationCard({ configuration, saving, applyState, onSave }: ConfigurationCardProps) {
  const [activeProfileId, setActiveProfileId] = useState(configuration?.tunnelProfiles.activeProfileId ?? '');
  const [profiles, setProfiles] = useState(configuration?.tunnelProfiles.profiles ?? []);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveProfileId(configuration?.tunnelProfiles.activeProfileId ?? '');
      setProfiles(configuration?.tunnelProfiles.profiles ?? []);
      setCredentials({});
    });
    return () => { cancelled = true; };
  }, [configuration]);
  if (!configuration) return <UnavailableConfiguration title="Tunnel Profiles" />;
  const updateProfile = (id: string, patch: Partial<NetworkDesiredConfiguration['tunnelProfiles']['profiles'][number]>) => setProfiles((current) => current.map((profile) => profile.id === id ? { ...profile, ...patch } : profile));
  const addProfile = () => {
    const id = `tunnel-${Date.now()}`;
    setProfiles((current) => [...current, { id, provider: 'ngrok', label: 'New tunnel', credentialConfigured: false, parameters: {} }]);
  };
  const removeProfile = (id: string) => {
    setProfiles((current) => current.filter((profile) => profile.id !== id));
    if (activeProfileId === id) setActiveProfileId('');
  };
  return <ConfigurationCard title="Saved tunnel profiles" applyState={applyState}>
    <label className="block space-y-2 text-sm font-medium">Active profile<select value={activeProfileId} onChange={(event) => setActiveProfileId(event.target.value)} className="block h-10 w-full rounded-md border border-input bg-background px-3 sm:max-w-sm"><option value="">None</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.provider}</option>)}</select></label>
    <div className="space-y-3">{profiles.map((profile) => <div key={profile.id} className="space-y-3 rounded-md border border-border p-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField name={`tunnel-label-${profile.id}`} label="Label" value={profile.label} onChange={(label) => updateProfile(profile.id, { label })} />
        <label className="block space-y-2 text-sm font-medium">Provider<select value={profile.provider} onChange={(event) => updateProfile(profile.id, { provider: event.target.value as typeof profile.provider, parameters: {} })} className="block h-10 w-full rounded-md border border-input bg-background px-3"><option value="ngrok">ngrok</option><option value="cloudflare">Cloudflare</option><option value="frp">frp</option></select></label>
        <TextField name={`tunnel-url-${profile.id}`} label="Public endpoint" value={profile.publicEndpoint ?? ''} onChange={(publicEndpoint) => updateProfile(profile.id, { publicEndpoint })} />
        <TextField name={`tunnel-credential-${profile.id}`} label={profile.credentialConfigured ? 'Replace credential (configured)' : 'Credential'} type="password" value={credentials[profile.id] ?? ''} onChange={(credential) => setCredentials((current) => ({ ...current, [profile.id]: credential }))} />
      </div>
      <details><summary className="cursor-pointer font-medium">Provider-specific parameters</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{parameterFieldsFor(profile.provider).map(({ key, label }) => <TextField key={key} name={`tunnel-${key}-${profile.id}`} label={label} value={profile.parameters?.[key] ?? ''} onChange={(value) => updateProfile(profile.id, { parameters: { ...profile.parameters, [key]: value } })} />)}</div></details>
      <div className="flex justify-between"><span className="text-xs text-muted-foreground">{activeProfileId === profile.id ? 'Active after restart' : 'Inactive'} · credential {profile.credentialConfigured ? 'configured' : 'missing'}</span><Button type="button" size="sm" variant="ghost" onClick={() => removeProfile(profile.id)}>Remove</Button></div>
    </div>)}</div>
    <Button type="button" size="sm" variant="outline" onClick={addProfile}>Add tunnel profile</Button>
    <SaveConfigurationButton label="Save tunnel profiles" saving={saving} onClick={() => onSave({ tunnelProfiles: { activeProfileId, profiles: profiles.map((profile) => ({ id: profile.id, provider: profile.provider, label: profile.label, publicEndpoint: profile.publicEndpoint, parameters: profile.parameters, ...(credentials[profile.id] ? { credential: credentials[profile.id] } : {}) })) } })} />
  </ConfigurationCard>;
}

function parameterFieldsFor(provider: 'ngrok' | 'cloudflare' | 'frp'): Array<{ key: string; label: string }> {
  if (provider === 'ngrok') return [{ key: 'region', label: 'Region' }, { key: 'hostname', label: 'Reserved hostname' }];
  if (provider === 'cloudflare') return [{ key: 'tunnelId', label: 'Tunnel ID' }, { key: 'hostname', label: 'Hostname' }];
  return [{ key: 'serverHost', label: 'Server host' }, { key: 'serverPort', label: 'Server port' }, { key: 'remotePort', label: 'Remote port' }];
}

function P2pConfigurationCard({ configuration, saving, applyState, onSave }: ConfigurationCardProps) {
  const [value, setValue] = useState(configuration?.p2p);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setValue(configuration?.p2p);
    });
    return () => { cancelled = true; };
  }, [configuration]);
  if (!value) return <UnavailableConfiguration title="P2P" />;
  return <ConfigurationCard title="Saved P2P configuration" applyState={applyState}>
    <ToggleField label="Enable P2P fallback" checked={value.enabled} onChange={(enabled) => setValue({ ...value, enabled })} />
    <TextField name="signalService" label="Signal service" value={value.signalService} onChange={(signalService) => setValue({ ...value, signalService })} />
    <label className="block space-y-2 text-sm font-medium">Fallback policy<select value={value.fallbackPolicy} onChange={(event) => setValue({ ...value, fallbackPolicy: event.target.value as typeof value.fallbackPolicy })} className="block h-10 w-full rounded-md border border-input bg-background px-3 sm:max-w-sm"><option value="never">Never</option><option value="when-direct-unavailable">When direct is unavailable</option><option value="prefer-p2p">Prefer P2P</option></select></label>
    <SaveConfigurationButton label="Save P2P configuration" saving={saving} onClick={() => onSave({ p2p: value })} />
  </ConfigurationCard>;
}

interface ConfigurationCardProps { configuration?: NetworkDesiredConfiguration; saving: boolean; applyState?: string; onSave(patch: NetworkConfigurationPatch): void }
function ConfigurationCard({ title, applyState, children }: { title: string; applyState?: string; children: ReactNode }) { return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>Desired configuration · not presented as observed until verified</CardDescription></CardHeader><CardContent className="space-y-4">{applyState === 'restart-required' ? <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">Saved · restart required</div> : null}{children}</CardContent></Card>; }
function TextField({ name, label, value, type = 'text', onChange }: { name: string; label: string; value: string; type?: string; onChange(value: string): void }) { return <label className="block space-y-2 text-sm font-medium">{label}<input name={name} type={type} value={value} onChange={(event) => onChange(event.target.value)} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm" /></label>; }
function NumberField({ name, label, value, min, max, onChange }: { name: string; label: string; value: number; min: number; max: number; onChange(value: number): void }) { return <label className="block space-y-2 text-sm font-medium">{label}<input name={name} type="number" value={value} min={min} max={max} onChange={(event) => onChange(event.target.valueAsNumber)} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm" /></label>; }
function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) { return <label className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm font-medium">{label}<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }
function SaveConfigurationButton({ label, saving, onClick }: { label: string; saving: boolean; onClick(): void }) { return <div className="flex justify-end"><Button type="button" onClick={onClick} disabled={saving}>{saving ? 'Saving…' : label}</Button></div>; }

function EndpointCard({ endpoint, loading }: { endpoint?: string; loading: boolean }) {
  const rows = [
    { label: 'Canonical URL', value: endpoint },
    { label: 'API endpoint', value: endpoint ? resolveEndpointPath(endpoint, '/api/') : undefined },
  ];
  const copyEndpoint = async (label: string, value: string) => {
    await window.navigator.clipboard.writeText(value);
    toast({ description: `${label} copied` });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="h-4 w-4" aria-hidden="true" />
          接入点
        </CardTitle>
        <CardDescription>{loading ? '正在解析接入点' : 'Observed endpoints · Currently effective route is the canonical URL'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map(({ label, value }) => <div key={label} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
          <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">{label}</div><div className="mt-1 break-words text-sm text-foreground">{value || 'Unavailable'}</div></div>
          {value ? <div className="flex shrink-0 gap-1">
            <Button type="button" size="icon" variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copyEndpoint(label, value)}><Copy className="h-4 w-4" aria-hidden="true" /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label={`Open ${label}`} onClick={() => window.open(value, '_blank', 'noopener,noreferrer')}><ExternalLink className="h-4 w-4" aria-hidden="true" /></Button>
          </div> : null}
        </div>)}
      </CardContent>
    </Card>
  );
}

function resolveEndpointPath(endpoint: string, path: string): string {
  try {
    return new URL(path, endpoint).toString();
  } catch {
    return endpoint;
  }
}

function AddressCard({
  sections,
  loading,
  diagnostics,
  checkedAt,
}: {
  sections: Array<{ key: string; title: string; values: string[] }>;
  loading: boolean;
  diagnostics: NetworkDiagnosticCheckResult[];
  checkedAt?: Date;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wifi className="h-4 w-4" aria-hidden="true" />
          网络地址
        </CardTitle>
        <CardDescription>{loading ? '正在刷新地址' : '由运行时网络能力上报'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sections.map((section) => (
          <div key={section.key}>
            <div className="text-xs font-medium text-muted-foreground">{section.title}</div>
            {section.values.length > 0 ? (
              <div className="mt-1 space-y-1">
                {section.values.map((value) => <AddressEvidence key={value} scope={section.key} value={value} diagnostics={diagnostics} checkedAt={checkedAt} />)}
              </div>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">未提供</div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AddressEvidence({ scope, value, diagnostics, checkedAt }: { scope: string; value: string; diagnostics: NetworkDiagnosticCheckResult[]; checkedAt?: Date }) {
  const parsed = parseObservedAddress(value);
  const endpointCheck = diagnostics.find((check) => check.id === 'endpoint');
  return <div className="rounded-md border border-border p-3 text-sm">
    <div className="break-words font-medium text-foreground">{value}</div>
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      <EvidenceTerm label="Interface" value={scope === 'local' ? 'Loopback' : scope === 'lan' ? 'LAN interface (name not reported)' : 'Public route'} />
      <EvidenceTerm label="IP version" value={parsed.ipVersion} />
      <EvidenceTerm label="Port" value={parsed.port} />
      <EvidenceTerm label="Reachability" value={endpointCheck ? diagnosticLabel(endpointCheck.status) : 'Not checked'} />
      <EvidenceTerm label="Latency" value={endpointCheck?.durationMs == null ? 'Not checked' : `${endpointCheck.durationMs} ms`} />
      <EvidenceTerm label="Last checked" value={endpointCheck?.checkedAt ? formatDateTime(endpointCheck.checkedAt) : checkedAt ? checkedAt.toLocaleString() : 'Not checked'} />
    </dl>
  </div>;
}

function EvidenceTerm({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="text-right text-foreground">{value}</dd></div>; }

function parseObservedAddress(value: string): { ipVersion: string; port: string } {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ipVersion = host.includes(':') ? 'IPv6' : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? 'IPv4' : 'Resolved hostname';
    return { ipVersion, port: url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : 'Not reported') };
  } catch { return { ipVersion: 'Not reported', port: 'Not reported' }; }
}

function diagnosticLabel(status: NetworkDiagnosticCheckResult['status']): string { return status === 'ok' ? 'Reachable' : status === 'warning' ? 'Warning' : status === 'error' ? 'Unreachable' : 'Unsupported'; }

function ObservedDnsCard({ status }: { status?: NetworkSettingsStatus }) {
  const configured = status?.configuration?.domainDns;
  const publicHosts = (status?.addresses.public ?? []).map((value) => { try { return new URL(value).hostname; } catch { return value; } });
  return <Card><CardHeader><CardTitle className="text-base">Observed DNS</CardTitle><CardDescription>Observed state is kept separate from desired DNS policy.</CardDescription></CardHeader><CardContent className="space-y-3"><CapabilityRow label="Runtime status" capability={status?.dns} /><dl className="grid gap-2 text-sm sm:grid-cols-2"><EvidenceTerm label="Observed hostnames" value={publicHosts.join(', ') || 'Not reported'} /><EvidenceTerm label="Expected domain" value={configured?.domain || 'Not configured'} /><EvidenceTerm label="Expected value" value={status?.addresses.public[0] || 'Not reported'} /><EvidenceTerm label="Provider" value={configured?.provider || 'Not configured'} /></dl></CardContent></Card>;
}

function ObservedTlsCard({ status }: { status?: NetworkSettingsStatus }) {
  const desired = status?.configuration?.https;
  return <Card><CardHeader><CardTitle className="text-base">Observed HTTPS</CardTitle><CardDescription>Certificate evidence reported by the active runtime.</CardDescription></CardHeader><CardContent className="space-y-3"><CapabilityRow label="TLS" capability={status?.tls} extra={status?.tls.expiresAt ? `Expires ${formatDateTime(status.tls.expiresAt)}` : undefined} /><dl className="grid gap-2 text-sm sm:grid-cols-2"><EvidenceTerm label="Certificate domains" value={status?.tls.domains?.join(', ') || desired?.domains.join(', ') || 'Not reported'} /><EvidenceTerm label="Issuer" value={status?.tls.issuer || 'Not reported by runtime'} /><EvidenceTerm label="Validity" value={status?.tls.validFrom ? `${formatDateTime(status.tls.validFrom)} — ${status.tls.expiresAt ? formatDateTime(status.tls.expiresAt) : 'open'}` : status?.tls.status ?? 'Not reported'} /><EvidenceTerm label="Expiry" value={status?.tls.expiresAt ? formatDateTime(status.tls.expiresAt) : 'Not reported'} /><EvidenceTerm label="Renewal status" value={status?.tls.renewalStatus || (status?.actions.renewCertificate ? 'Renewal available' : 'Renewal unavailable')} /><EvidenceTerm label="Renewal policy" value={desired ? `${desired.renewBeforeDays} days before expiry` : 'Not configured'} /></dl></CardContent></Card>;
}

function CapabilityCard({ status }: { status?: NetworkSettingsStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4" aria-hidden="true" />
          网络能力
        </CardTitle>
        <CardDescription>服务端声明的网络支持</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <CapabilityRow label="TLS" capability={status?.tls} extra={status?.tls.expiresAt ? `到期时间 ${formatDateTime(status.tls.expiresAt)}` : undefined} />
        <CapabilityRow label="DNS" capability={status?.dns} />
        <CapabilityRow label="Tunnel" capability={status?.tunnel} />
      </CardContent>
    </Card>
  );
}

function ActionsCard({
  status,
  endpoint,
  diagnostics,
  diagnosing,
  renewing,
  onDiagnose,
  onRenewCertificate,
}: {
  status?: NetworkSettingsStatus;
  endpoint?: string;
  diagnostics: NetworkDiagnosticCheckResult[];
  diagnosing: boolean;
  renewing: boolean;
  onDiagnose: () => void;
  onRenewCertificate: () => void;
}) {
  const diagnosticReport = diagnostics.length > 0 ? formatNetworkDiagnosticReport({
    generatedAt: new Date().toISOString(),
    endpoint,
    checks: diagnostics,
  }) : undefined;
  const copyDiagnostics = async () => {
    if (!diagnosticReport) return;
    await window.navigator.clipboard.writeText(diagnosticReport);
    toast({ description: 'Diagnostic report copied' });
  };
  const exportDiagnostics = () => {
    if (!diagnosticReport) return;
    const url = URL.createObjectURL(new Blob([diagnosticReport], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `xpod-network-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" aria-hidden="true" />
          操作
        </CardTitle>
        <CardDescription>仅显示网络能力允许的操作</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {status?.actions.diagnose ? (
            <Button type="button" size="sm" variant="outline" onClick={onDiagnose} disabled={diagnosing}>
              <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
              连通性诊断
            </Button>
          ) : null}
          {status?.actions.renewCertificate ? (
            <Button type="button" size="sm" variant="subtle" onClick={onRenewCertificate} disabled={renewing}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              续签证书
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={() => void copyDiagnostics()} disabled={!diagnosticReport}>
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />Copy diagnostics
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={exportDiagnostics} disabled={!diagnosticReport}>
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />Export diagnostics
          </Button>
        </div>
        {diagnostics.length > 0 ? (
          <div className="space-y-2">
            {diagnostics.map((check) => (
              <div key={check.id} className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">{check.label}</div>
                  <Badge variant={check.status === 'ok' ? 'secondary' : 'outline'}>{check.status}</Badge>
                </div>
                {check.detail ? <div className="mt-1 break-words text-xs text-muted-foreground">{check.detail}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">尚未运行过诊断。</div>
        )}
      </CardContent>
    </Card>
  );
}

function CapabilityRow({
  label,
  capability,
  extra,
}: {
  label: string;
  capability?: { supported: boolean; status: string };
  extra?: string;
}) {
  const supported = capability?.supported === true;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">{supported ? label : `${label} 不支持`}</div>
          <div className="text-xs text-muted-foreground">{capability?.status ?? '读取中'}</div>
        </div>
        <Badge variant={supported ? 'secondary' : 'outline'}>{supported ? '支持' : '不支持'}</Badge>
      </div>
      {extra ? <div className="mt-2 text-xs text-muted-foreground">{extra}</div> : null}
    </div>
  );
}

function formatDateTime(value?: string): string {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无记录';
  return date.toLocaleString();
}
