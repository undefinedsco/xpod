import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Skeleton } from '@undefineds.co/shared-ui';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import { getAdminConfig, getAdminStatus, getDdnsStatus, getProvisionStatus, getPublicIpCheck, resolveAdminAccessBaseUrl, triggerRestart, updateAdminConfig, type AdminConfig, type AdminStatus, type ProvisionStatus, type PublicIpCheckResult } from '../../api/admin';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { useAuth } from '../../context/AuthContextValue';
import { fetchAccountStorageBindings } from '../../auth/account-storage-bindings';
import { createFirstPodAndWaitForBinding, deriveFirstPodNameCandidate } from '../../utils/consent-first-pod';
import { storedAccountTokenHeaders } from '../../utils/account-session';
import { resolveProvisionCodeForCurrentScope } from '../../utils/pod';
import { projectStorageBackends, type SettingsEvidenceRow } from './settings-projection';
import { reachablePodUrl } from './pod-url';
import { createXpodAiConnectionsClient } from '../../api/ai-connections';
import { createServiceAccessPermissionCapability } from '../../api/service-access-acp';
import { parseAiConnectionsServiceAccess } from '@undefineds.co/ai-connections';
import {
  clearConsentContinuation,
  confirmConsentInteractionAtAuthority,
  consumeConfirmedConsentContinuation,
  consumeManagementContinuation,
  isAccountReturnTo,
  readConfirmedConsentContinuation,
  readManagementContinuation,
  resolveAuthoritativeAccountId,
  type ConsentContinuation,
  type ManagementContinuation,
} from '../../utils/safe-continuation';
import { fetchOidcCancelRedirectLocation, resolveOidcCancelUrl } from '../ConsentPage.utils';

/**
 * Rebuild a cancel target for one interaction on a page whose own URL carries no
 * interaction scope (`/settings/pod`). `scopeAccountUrl` cannot help here: it
 * only rewrites when the current location already has the scope, so it would
 * fall back to the unscoped `/.account/oidc/cancel/` and cancel the wrong (or no)
 * interaction.
 */
function interactionScopedCancelUrl(
  interaction: string,
  controls: Parameters<typeof resolveOidcCancelUrl>[0],
  idpIndex: string,
): string {
  const resolved = resolveOidcCancelUrl(controls, idpIndex);
  let suffix = '/oidc/cancel/';
  try {
    const url = new URL(resolved, window.location.origin);
    if (url.origin === window.location.origin) {
      const stripped = url.pathname.replace(/^\/\.account/u, '');
      if (stripped.startsWith('/')) suffix = stripped.endsWith('/') ? stripped : `${stripped}/`;
    }
  } catch { /* keep the canonical suffix */ }
  return `${interaction}${suffix}`;
}

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
    {applyState ? <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200"><span>{applyState}</span><Button type="button" size="sm" variant="outline" onClick={() => void triggerRestart()}><RotateCcw className="mr-2 h-4 w-4" />Restart Xpod</Button></div> : null}
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
function PodManagementContent({ runtime, publicRoute }: { runtime: ReturnType<typeof useXpodSolidRuntime>; publicRoute: PublicIpCheckResult | null }) {
  const account = useAuth();
  const [bindings, setBindings] = useState<StorageBinding[] | null>(null);
  const [listError, setListError] = useState('');
  const [podName, setPodName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  const [consentResume, setConsentResume] = useState<ConsentContinuation | null>(null);
  const [managementResume, setManagementResume] = useState<ManagementContinuation | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [resuming, setResuming] = useState(false);
  const consentCapabilityRef = useRef<(() => void) | undefined>(undefined);
  const managementCapabilityRef = useRef<(() => void) | undefined>(undefined);

  const controls = account.controls;
  const idpIndex = account.idpIndex;
  const accountId = resolveAuthoritativeAccountId(controls, account.identity);
  const bindAccountCapability = account.bindAccountCapability;
  const loadBindings = useCallback(async () => {
    setListError('');
    try {
      setBindings(await fetchAccountStorageBindings({
        controls, origin: window.location.origin, trustedAccountIndex: idpIndex,
      }));
    } catch {
      setBindings(null);
      setListError('暂时无法读取存储绑定，请重试。');
    }
  }, [controls, idpIndex]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void loadBindings(); });
    return () => { cancelled = true; };
  }, [loadBindings]);

  // Resume context: only a genuinely pending authorization — confirmed against
  // the server for this Account — continues that exact task. A daily visit only
  // offers the Account return address; a stale consent task is never resumed.
  //
  // The Account-capability closure is captured together with the confirmed
  // record: a later click must prove the *same* session is still current, not
  // re-bind whatever session happens to be active when the user clicks.
  useEffect(() => {
    // Without a current authoritative Account no continuation can be resumed.
    // The captured capabilities are dropped here, and the banners are derived
    // from `accountId` in render, so a missing or switched Account hides them
    // immediately without a synchronous setState inside the effect body.
    consentCapabilityRef.current = undefined;
    managementCapabilityRef.current = undefined;
    if (!accountId) return;
    let cancelled = false;
    const assertAccount = bindAccountCapability?.();
    void (async () => {
      let confirmed: ConsentContinuation | null = null;
      try {
        confirmed = await readConfirmedConsentContinuation(
          { accountId },
          { assertCurrent: assertAccount },
        );
      } catch {
        confirmed = null;
      }
      if (cancelled) return;
      consentCapabilityRef.current = confirmed ? assertAccount : undefined;
      const management = confirmed ? null : readManagementContinuation({ accountId });
      managementCapabilityRef.current = management ? assertAccount : undefined;
      setConsentResume(confirmed);
      setManagementResume(management);
    })();
    return () => { cancelled = true; };
  }, [accountId, bindAccountCapability]);

  /**
   * Drop the resume banner when the captured session is no longer the current
   * one. Returns the captured capability so the async step can re-assert it after
   * every await.
   */
  const assertResumeSession = useCallback((
    expectedAccountId: string,
    assertAccount: (() => void) | undefined,
  ): (() => void) | null => {
    const currentAccountId = resolveAuthoritativeAccountId(controls, account.identity);
    if (!assertAccount || currentAccountId !== expectedAccountId) return null;
    try {
      assertAccount();
    } catch {
      return null;
    }
    return assertAccount;
  }, [account.identity, controls]);

  const resumeAuthorization = useCallback(async () => {
    if (!consentResume || resuming) return;
    const assertAccount = assertResumeSession(consentResume.accountId, consentCapabilityRef.current);
    if (!assertAccount) {
      setConsentResume(null);
      setResumeError('这个授权任务已失效，请回到应用重新发起。');
      return;
    }
    setResuming(true);
    setResumeError('');
    try {
      // Re-confirm with the server at click time: the interaction may have been
      // cancelled since the banner was confirmed on load.
      const confirmed = await confirmConsentInteractionAtAuthority(consentResume, {
        headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
        assertCurrent: assertAccount,
      });
      const consumed = confirmed
        ? consumeConfirmedConsentContinuation(consentResume, { accountId: consentResume.accountId }, { assertCurrent: assertAccount })
        : null;
      if (!consumed) {
        clearConsentContinuation();
        setConsentResume(null);
        setResumeError('这个授权任务已失效，请回到应用重新发起。');
        setResuming(false);
        return;
      }
      window.location.assign(consumed.returnTo);
    } catch {
      setConsentResume(null);
      setResumeError('这个授权任务已失效，请回到应用重新发起。');
      setResuming(false);
    }
  }, [assertResumeSession, consentResume, resuming]);

  const cancelAuthorization = useCallback(async () => {
    if (!consentResume || resuming) return;
    const assertAccount = assertResumeSession(consentResume.accountId, consentCapabilityRef.current);
    if (!assertAccount) {
      setConsentResume(null);
      setResumeError('这个授权任务已失效，请回到应用重新发起。');
      return;
    }
    setResuming(true);
    setResumeError('');
    try {
      const redirect = await fetchOidcCancelRedirectLocation({
        // The heavy page has no interaction scope in its URL, so the cancel
        // target must be rebuilt from the confirmed interaction; otherwise the
        // request would fall back to the unscoped `/.account/oidc/cancel/`.
        cancelUrl: interactionScopedCancelUrl(consentResume.interaction, controls, idpIndex),
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      assertAccount();
      clearConsentContinuation();
      window.location.assign(redirect);
    } catch (error: unknown) {
      // Server messages can be raw English; keep the safe localised copy and
      // leave the diagnostic to tests/logs.
      void error;
      setResumeError('取消授权失败，请重试。');
      setResuming(false);
    }
  }, [assertResumeSession, consentResume, controls, idpIndex, resuming]);

  const returnToAccount = useCallback(() => {
    if (!managementResume || resuming) return;
    const assertAccount = assertResumeSession(managementResume.accountId, managementCapabilityRef.current);
    if (!assertAccount) {
      setManagementResume(null);
      return;
    }
    const consumed = consumeManagementContinuation({ accountId: managementResume.accountId });
    if (!consumed || !isAccountReturnTo(consumed.returnTo)) {
      setManagementResume(null);
      return;
    }
    window.location.assign(consumed.returnTo);
  }, [assertResumeSession, managementResume, resuming]);

  const suggestedName = useMemo(() => deriveFirstPodNameCandidate([
    runtime.webId,
    account.identity?.username,
    controls?.account?.username,
  ]), [runtime.webId, account.identity?.username, controls?.account?.username]);

  const createPod = async (event: React.FormEvent) => {
    event.preventDefault();
    const createPodUrl = controls?.account?.pod;
    const username = (podName.trim() || suggestedName || '').trim();
    if (creating) return;
    if (!createPodUrl) { setCreateError('当前部署没有公布创建存储空间的入口。'); return; }
    if (!username) { setCreateError('无法从当前账号推断 Pod 名称，请手动填写。'); return; }
    setCreating(true); setCreateError(''); setCreateNotice('');
    try {
      await createFirstPodAndWaitForBinding({
        assertCurrentAccount: account.bindAccountCapability?.(),
        createPodUrl,
        headers: storedAccountTokenHeaders(),
        provisionCode: await resolveProvisionCodeForCurrentScope(),
        trustedAccountIndex: idpIndex,
        username,
      });
      setPodName('');
      setCreateNotice('存储空间已创建。');
      await loadBindings();
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : '无法创建存储空间，请重试。');
    } finally {
      setCreating(false);
    }
  };

  const podUrl = reachablePodUrl(runtime.podUrl, window.location.origin);
  const rows: SettingsEvidenceRow[] = [
    { label: 'Pod name', value: podNameLabel(runtime.podUrl) },
    { label: 'Pod URL', value: podUrl ?? 'Not discovered' },
    { label: 'Public route', value: publicRouteLabel(publicRoute), detail: publicRoute?.detail ?? 'Not checked by this runtime' },
    { label: 'Session', value: runtime.state.status },
  ];

  // A continuation belongs only to the Account that confirmed it. Deriving the
  // visible banner from the current authoritative Account id makes a switched or
  // absent Account hide the task immediately, without clearing state in an effect.
  const activeConsentResume = consentResume && consentResume.accountId === accountId ? consentResume : null;
  const activeManagementResume = managementResume && managementResume.accountId === accountId ? managementResume : null;

  return <>
    {activeConsentResume ? (
      <div role="status" data-testid="consent-resume-banner" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/10 p-3">
        <div className="text-sm">
          <div className="font-medium text-foreground">有应用正在等待你的授权</div>
          <div className="text-xs text-muted-foreground">完成这里的操作后可以回到原来的授权继续。</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={resuming} onClick={resumeAuthorization}>回到授权</Button>
          <Button type="button" variant="outline" disabled={resuming} onClick={() => void cancelAuthorization()}>取消授权</Button>
        </div>
      </div>
    ) : activeManagementResume ? (
      <div role="status" data-testid="management-resume-banner" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <div className="text-sm font-medium text-foreground">完成管理后可以回到账号页。</div>
        <Button type="button" variant="outline" onClick={returnToAccount}>返回账号</Button>
      </div>
    ) : null}
    {resumeError ? <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{resumeError}</div> : null}
    <EvidenceGrid rows={rows} />
    <Button type="button" variant="outline" disabled={!podUrl} onClick={() => podUrl && window.open(podUrl, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-2 h-4 w-4" />Open Pod</Button>

    <div className="space-y-2">
      <div className="text-sm font-medium">属于当前账号的存储空间</div>
      {listError ? <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{listError}</div> : null}
      {bindings === null && !listError ? <div role="status" className="text-sm text-muted-foreground">正在读取…</div> : null}
      {bindings?.length === 0 ? (
        <div role="status" className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
          这个账号还没有任何存储空间。创建后即可用它授权应用访问。
        </div>
      ) : null}
      {bindings && bindings.length > 0 ? (
        <ul className="space-y-2">
          {bindings.map((binding) => (
            <li key={`${binding.webId}|${binding.storageUrl}`} className="rounded-lg border border-border p-3 text-sm">
              <div className="break-all font-medium">{binding.storageUrl}</div>
              <div className="mt-1 break-all text-xs text-muted-foreground">{binding.webId}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>

    <form onSubmit={createPod} className="space-y-2 rounded-lg border border-border p-3">
      <label className="block text-sm font-medium" htmlFor="pod-management-name">创建存储空间</label>
      <p className="text-xs text-muted-foreground">创建是一次显式操作：不会因为登录或授权而自动发生。</p>
      <div className="flex flex-wrap gap-2">
        <Input
          id="pod-management-name"
          className="h-10 min-w-48 flex-1"
          value={podName}
          placeholder={suggestedName || 'my-pod'}
          disabled={creating}
          onChange={(event) => setPodName(event.currentTarget.value)}
        />
        <Button type="submit" disabled={creating}>{creating ? '正在创建…' : '创建'}</Button>
      </div>
      {createError ? <div role="alert" className="text-sm text-destructive">{createError}</div> : null}
      {createNotice ? <div role="status" className="text-sm text-muted-foreground">{createNotice}</div> : null}
    </form>
  </>;
}

function SubjectContent({ kind, runtime, admin, configuration, provision, publicRoute, save }: { kind: SystemSettingsSubjectKind; runtime: ReturnType<typeof useXpodSolidRuntime>; admin: AdminStatus | null; configuration: AdminConfig | null; provision: ProvisionStatus | null; publicRoute: PublicIpCheckResult | null; save(patch: Record<string, string>): Promise<void> }) {
  const env = configuration?.env ?? {};
  if (kind === 'pod') {
    return <PodManagementContent runtime={runtime} publicRoute={publicRoute} />;
  }
  if (kind === 'identity-access') return <IdentityAccessContent runtime={runtime} />;
  if (kind === 'storage') return <><EvidenceGrid rows={projectStorageBackends(env, configuration?.secrets)} /><p className="text-xs text-muted-foreground">Measured storage and bandwidth are intentionally shown in Status → Usage, not here. Storage migration is unavailable because this runtime does not report a migration capability.</p></>;
  if (kind === 'runtime') return <RuntimeForm env={env} admin={admin} save={save} />;
  if (kind === 'cloud') return <CloudForm env={env} provision={provision} save={save} />;
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
function TextInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label className="block space-y-2 text-sm font-medium">{label}<Input value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function SaveButton({ onClick }: { onClick(): void }) { return <div className="flex justify-end"><Button type="button" onClick={onClick}>Save configuration</Button></div>; }
function podNameLabel(value: string | undefined): string { if (!value) return 'Not discovered'; try { return new URL(value).pathname.split('/').filter(Boolean).at(-1) || new URL(value).hostname; } catch { return value; } }

/**
 * The reachability verdict is the runtime's, and it distinguishes "checked and
 * broken" from "could not be verified" instead of assuming a configured domain
 * works.
 */
function publicRouteLabel(route: PublicIpCheckResult | null): string {
  if (!route) return 'Not checked';
  if (route.status === 'pass') return 'Reachable';
  if (route.status === 'fail') return 'Not reachable';
  return 'Not verified';
}

const titles: Record<SystemSettingsSubjectKind, string> = { pod: 'Pod', 'identity-access': 'Identity & Access', storage: 'Storage', runtime: 'Runtime', cloud: 'Cloud', advanced: 'Advanced' };
const descriptions: Record<SystemSettingsSubjectKind, string> = { pod: 'Current Pod identity and authority boundary.', 'identity-access': 'Session, account, and app/service access.', storage: 'Authority storage backends and health configuration.', runtime: 'Edition, startup, paths, and restart behavior.', cloud: 'Node registration and cluster coordination.', advanced: 'Bounded logging and runtime compatibility controls.' };
