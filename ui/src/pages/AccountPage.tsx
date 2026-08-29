import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogOut, User, HardDrive, Key, Plus, Trash2, Globe, Database, Shield, Copy, Check, ChevronDown, Info, ArrowRight, AlertCircle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContextValue';
import {
  buildPodCreatePayload,
  clearStoredProvisionCode,
  getStoredProvisionCode,
  resolveProvisionCodeForCurrentScope,
} from '../utils/pod';
import { clearAccountSessionToken, storedAccountTokenHeaders } from '../utils/account-session';
import { resolveHostedAccountControlUrl, resolveSameOriginAccountControlUrl } from '../utils/account-control-url';
import {
  currentStorageScope,
  dedupeScopedEntries,
  lookupProvisionScopedWebIds,
  scopedEntriesFromPods,
  storageModeFor,
  storageUrlBelongsToRoot,
  type ScopedWebIdEntry,
  type StorageMode,
} from '../utils/storage-scope';
import { xpodFirstPodErrors } from '../auth/xpod-account-copy';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';

interface PodView {
  id: string;
  resourceUrl?: string;
  name?: string;
  storageMode?: StorageMode;
}

interface AccountPodResponse {
  pods?: Record<string, string>;
}

interface AccountWebIdResponse {
  webIdLinks?: Record<string, string>;
}

interface AccountClientCredentialsResponse {
  clientCredentials?: Record<string, string>;
}

interface CredentialView {
  id: string;
  resourceUrl: string;
  webId?: string;
}

function derivePodName(storageUrl: string): string | undefined {
  try {
    const url = new URL(storageUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1];
  } catch {
    return undefined;
  }
}

function isAccountIssuerOrigin(idpIndex: string | undefined): boolean {
  if (!idpIndex || typeof window === 'undefined') {
    return false;
  }
  try {
    return new URL(idpIndex, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function normalizePods(json: AccountPodResponse | undefined): PodView[] {
  const pods = json?.pods;
  if (!pods || typeof pods !== 'object') {
    return [];
  }

  return Object.entries(pods).map(([storageUrl, resourceUrl]) => ({
    id: storageUrl,
    resourceUrl,
    name: derivePodName(storageUrl),
  }));
}

function podsFromScopedEntries(entries: ScopedWebIdEntry[]): PodView[] {
  const seen = new Set<string>();
  const pods: PodView[] = [];
  for (const entry of entries) {
    if (seen.has(entry.storageUrl)) {
      continue;
    }
    seen.add(entry.storageUrl);
    pods.push({
      id: entry.storageUrl,
      name: derivePodName(entry.storageUrl),
      storageMode: entry.storageMode ?? storageModeFor(entry.webId, entry.storageUrl),
    });
  }
  return pods;
}

function credentialIdFromUrl(resourceUrl: string): string {
  try {
    const segments = new URL(resourceUrl).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? resourceUrl;
  } catch {
    return resourceUrl.split('/').filter(Boolean).pop() ?? resourceUrl;
  }
}

function localProvisionError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : '';
  if (
    message === 'fetch failed'
    || message.includes('Failed to fetch')
    || message.includes('Cloud storage is not ready')
    || message.includes('provision_refresh_failed')
    || message.includes('provision_refresh_unavailable')
  ) {
    return xpodFirstPodErrors.cloudRouteUnavailable;
  }
  return fallback;
}

function accountActionError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : '';
  if (message.startsWith('Pod name is already taken.')) {
    return message;
  }
  return fallback;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { message?: unknown };
  return accountActionError(
    typeof body.message === 'string' ? new Error(body.message) : undefined,
    fallback,
  );
}

const brandTileClass = 'flex items-center justify-center rounded-lg bg-primary text-primary-foreground';
const cardClass = 'bg-card border border-border rounded-xl shadow-sm';
const iconMutedClass = 'w-4 h-4 text-muted-foreground shrink-0';
const labelClass = 'block text-xs text-muted-foreground mb-1';
const primaryButtonClass = 'bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-50';
const quietButtonClass = 'text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors';
const sectionTitleClass = 'text-sm font-semibold text-foreground flex items-center gap-2';
const inputClass = 'bg-background border border-input rounded-lg text-sm text-foreground focus:border-primary focus:outline-none';
const linkClass = 'text-xs font-mono text-primary hover:text-primary/80 truncate';
const copyButtonClass = 'p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors shrink-0';
const dangerButtonClass = 'p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors';

export function AccountPage() {
  const { controls, refetchControls, hasOidcPending, idpIndex } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [pods, setPods] = useState<PodView[]>([]);
  const [showCreatePod, setShowCreatePod] = useState(false);
  const [podName, setPodName] = useState('');
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [newCredential, setNewCredential] = useState<{ id: string; secret: string } | null>(null);
  const [showCreateCredential, setShowCreateCredential] = useState(false);
  const [credentialWebId, setCredentialWebId] = useState('');
  const [credentialName, setCredentialName] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showWebIdDropdown, setShowWebIdDropdown] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [accountWebIdUrl, setAccountWebIdUrl] = useState<string>();
  const [accountPodUrl, setAccountPodUrl] = useState<string>();
  const [accountBindingsUrl, setAccountBindingsUrl] = useState<string>();
  const [accountClientCredentialsUrl, setAccountClientCredentialsUrl] = useState<string>();
  const [accountLogoutUrl, setAccountLogoutUrl] = useState<string>();
  const passwordForgotUrl = resolveSameOriginAccountControlUrl(controls?.password?.forgot)
    ?? '/.account/login/password/forgot/';

  useEffect(() => {
    let active = true;
    void Promise.all([
      resolveHostedAccountControlUrl(controls?.account?.webId, fetch, idpIndex),
      resolveHostedAccountControlUrl(controls?.account?.pod, fetch, idpIndex),
      resolveHostedAccountControlUrl(controls?.account?.bindings, fetch, idpIndex),
      resolveHostedAccountControlUrl(controls?.account?.clientCredentials, fetch, idpIndex),
      resolveHostedAccountControlUrl(controls?.account?.logout, fetch, idpIndex),
    ]).then(([webIdUrl, podUrl, bindingsUrl, clientCredentialsUrl, logoutUrl]) => {
      if (!active) return;
      setAccountWebIdUrl(webIdUrl);
      setAccountPodUrl(podUrl);
      setAccountBindingsUrl(bindingsUrl);
      setAccountClientCredentialsUrl(clientCredentialsUrl);
      setAccountLogoutUrl(logoutUrl);
    });
    return () => {
      active = false;
    };
  }, [controls, idpIndex]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowWebIdDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // fallback
    }
  };

  const fetchData = useCallback(async () => {
    try {
      // The Cloud Account UI is not a Local Xpod host and must not probe its
      // own origin for `/provision/status`. A signed code arriving from the
      // Local Xpod remains enough to scope this account view.
      const provisionCode = accountBindingsUrl && !isAccountIssuerOrigin(idpIndex)
        ? await resolveProvisionCodeForCurrentScope(fetch, getStoredProvisionCode())
        : getStoredProvisionCode();
      const scope = currentStorageScope(window.location.origin, provisionCode);
      let scopedLookupError: string | null = null;
      let nextWebIds: string[] = [];
      let allWebIds: string[] = [];
      let allPods: PodView[] = [];
      let scopedEntries: ScopedWebIdEntry[] = [];
      if (accountBindingsUrl) {
        const bindings = await fetchAccountStorageBindings({
          controls: { account: { bindings: accountBindingsUrl } },
          origin: window.location.origin,
          trustedAccountIndex: idpIndex,
        });
        allWebIds = bindings.map((entry) => entry.webId);
        allPods = podsFromScopedEntries(bindings.map((entry) => ({
          webId: entry.webId,
          storageUrl: entry.storageUrl,
          storageMode: storageModeFor(entry.webId, entry.storageUrl),
        })));
      }
      if (accountWebIdUrl) {
        const res = await fetch(accountWebIdUrl, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountWebIdResponse;
          const links = json.webIdLinks || {};
          allWebIds = Array.from(new Set([...allWebIds, ...Object.keys(links)]));
        }
      }

      if (accountPodUrl) {
        const res = await fetch(accountPodUrl, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountPodResponse;
          const seen = new Set(allPods.map((pod) => pod.id));
          allPods = [...allPods, ...normalizePods(json).filter((pod) => !seen.has(pod.id))];
        }
      }

      if (scope) {
        if (scope.serviceToken) {
          try {
            scopedEntries = await lookupProvisionScopedWebIds(fetch, allWebIds, scope);
          } catch (error) {
            // Account identity and Local Pod reachability are independent.
            // Keep the Cloud-owned WebID visible when this device is offline
            // instead of collapsing the entire account page into an error.
            scopedEntries = [];
            scopedLookupError = localProvisionError(error, xpodFirstPodErrors.checkFailed);
          }
        } else {
          scopedEntries = scopedEntriesFromPods(allWebIds, allPods.map((pod) => pod.id), scope);
        }
      }
      scopedEntries = dedupeScopedEntries(scopedEntries);
      // Identity is Cloud-owned. A local provision scope only filters storage,
      // not the user's WebID. Hiding Cloud WebIDs made this page look like a
      // stuck sync when this device simply has no Pod yet.
      nextWebIds = allWebIds;
      const nextPods = scope?.serviceToken
        ? podsFromScopedEntries(scopedEntries)
        : scope
          ? allPods
          .filter((pod) => storageUrlBelongsToRoot(pod.id, scope?.root))
          .map((pod) => ({
            ...pod,
            storageMode: scopedEntries.find((entry) => storageUrlBelongsToRoot(pod.id, entry.storageUrl))?.storageMode,
          }))
          : allPods;

      setWebIds(nextWebIds);
      setPods(nextPods);

      if (accountClientCredentialsUrl) {
        const res = await fetch(accountClientCredentialsUrl, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountClientCredentialsResponse;
          const creds = json.clientCredentials || {};
          const scopedWebIds = new Set(nextWebIds);
          const resolvedCredentials = await Promise.all(Object.entries(creds)
            .map(async ([resourceUrl, webId]) => {
              const resolvedResourceUrl = await resolveHostedAccountControlUrl(resourceUrl, fetch, idpIndex);
              if (!resolvedResourceUrl) return undefined;
              const credential: CredentialView = {
                id: credentialIdFromUrl(resolvedResourceUrl),
                resourceUrl: resolvedResourceUrl,
                webId: typeof webId === 'string' ? webId : undefined,
              };
              return credential;
            }));
          setCredentials(resolvedCredentials
            .filter((credential): credential is CredentialView => credential !== undefined)
            .filter((credential) => credential.webId && scopedWebIds.has(credential.webId)));
        } else {
          setCredentials([]);
        }
      } else {
        setCredentials([]);
      }
      setAccountError(scopedLookupError);
    } catch (err) {
      console.error('Failed to fetch account data:', err);
      setWebIds([]);
      setPods([]);
      setCredentials([]);
      setAccountError(accountActionError(err, '无法加载账号信息，请重试。'));
    }
  }, [accountBindingsUrl, accountClientCredentialsUrl, accountPodUrl, accountWebIdUrl, idpIndex]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        void fetchData();
      }
    });
    return () => {
      active = false;
    };
  }, [fetchData]);

  const handleLogout = async () => {
    if (!accountLogoutUrl) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(accountLogoutUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders(),
        credentials: 'include',
      });
      if (res.ok) {
        clearStoredProvisionCode();
        clearAccountSessionToken();
        await refetchControls();
        navigate('/.account/');
      } else {
        setAccountError('退出登录失败，请重试。');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '退出登录失败，请重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreatePod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountPodUrl || !podName.trim()) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(accountPodUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        body: JSON.stringify(buildPodCreatePayload(podName)),
      });
      if (res.ok) {
        setPodName('');
        setShowCreatePod(false);
        // Refresh controls to get updated endpoints (including new WebID)
        await refetchControls();
        await fetchData();
        if (hasOidcPending) {
          navigate('/.account/oidc/consent/');
        }
      } else {
        setAccountError(await responseError(res, '无法创建存储空间，请重试。'));
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法创建存储空间，请重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeletePod = async (pod: PodView) => {
    const podResourceUrl = await resolveHostedAccountControlUrl(pod.resourceUrl, fetch, idpIndex);
    if (!podResourceUrl) return;
    if (!confirm(`Delete pod ${pod.id}? This cannot be undone.`)) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(podResourceUrl, { method: 'DELETE', headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        await fetchData();
      } else {
        setAccountError('无法删除存储空间，请重试。');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法删除存储空间，请重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateCredential = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountClientCredentialsUrl || !credentialWebId || !credentialName.trim()) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(accountClientCredentialsUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ name: credentialName.trim(), webId: credentialWebId }),
      });
      if (res.ok) {
        const json = await res.json();
        setNewCredential({ id: json.id, secret: json.secret });
        setShowCreateCredential(false);
        setCredentialWebId('');
        setCredentialName('');
        await fetchData();
      } else {
        setAccountError(await responseError(res, '无法创建客户端凭据，请重试。'));
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法创建客户端凭据，请重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const openCreateCredential = () => {
    if (webIds.length === 0) {
      setAccountError('请先创建存储空间，再创建客户端凭据。');
      return;
    }
    setCredentialWebId(webIds[0]);
    setCredentialName('');
    setShowCreateCredential(true);
  };

  const handleDeleteCredential = async (credential: CredentialView) => {
    const credentialResourceUrl = await resolveHostedAccountControlUrl(credential.resourceUrl, fetch, idpIndex);
    if (!credentialResourceUrl) return;
    if (!confirm('Delete this credential? This cannot be undone.')) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(credentialResourceUrl, { method: 'DELETE', headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        await fetchData();
      } else {
        setAccountError('无法撤销客户端凭据，请重试。');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法撤销客户端凭据，请重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-primary/5 rounded-full blur-[120px]" />
      </div>
      <header className="relative z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 ${brandTileClass}`}>
              <div className="w-4 h-4 border-2 border-primary-foreground rounded opacity-80" />
            </div>
            <div>
              <div className="font-semibold leading-tight">Xpod</div>
              <div className="text-[10px] text-muted-foreground leading-tight">Personal Messages Platform</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/.account/about/" className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${quietButtonClass}`}>
              <Info className="w-3.5 h-3.5" />
              About
            </Link>
            <button onClick={handleLogout} disabled={isLoading} className={`flex items-center gap-2 px-3 py-1.5 text-xs ${quietButtonClass}`}>
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-8">
        {accountError ? (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm leading-5">{accountError}</p>
            <button
              type="button"
              onClick={() => setAccountError(null)}
              className="rounded p-1 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label="关闭错误提示"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {/* OIDC Authorization Pending Banner */}
        {hasOidcPending && (
          <div className="p-4 bg-primary/10 border border-primary/30 rounded-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/20 rounded-lg">
                  <Shield className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Authorization Pending</p>
                  <p className="text-xs text-muted-foreground">An application is waiting for your authorization</p>
                </div>
              </div>
              <Link
                to="/.account/oidc/consent/"
                className={`flex items-center gap-2 px-4 py-2 ${primaryButtonClass} text-sm font-medium rounded-lg`}
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        )}

        <h1 className="text-2xl font-bold">Account Dashboard</h1>

        {/* Pods Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className={sectionTitleClass}><HardDrive className="w-4 h-4 text-primary" />Storage</h2>
            {accountPodUrl && (
              <button onClick={() => setShowCreatePod(true)} className={`flex items-center gap-1.5 px-3 py-1.5 ${primaryButtonClass} text-xs rounded-lg`}>
                <Plus className="w-3.5 h-3.5" />Add Pod
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mb-3">Your personal data stores (Pods). You own and control all data stored here.</p>
          
          {showCreatePod && (
            <form onSubmit={handleCreatePod} className={`mb-4 p-4 ${cardClass}`}>
              <label className="block text-xs text-muted-foreground mb-2">Pod Name</label>
              <div className="flex gap-2">
                <input type="text" value={podName} onChange={(e) => setPodName(e.target.value)} placeholder="my-pod" className={`flex-1 px-3 py-2 ${inputClass}`} required />
                <button type="submit" disabled={isLoading} className={`px-4 py-2 ${primaryButtonClass} text-xs rounded-lg`}>{isLoading ? 'Creating...' : 'Create'}</button>
                <button type="button" onClick={() => setShowCreatePod(false)} className="px-3 py-2 text-muted-foreground hover:text-foreground text-xs">Cancel</button>
              </div>
            </form>
          )}
          <div className={cardClass}>
            {pods.length === 0 ? (
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-3">
                  {webIds.length > 0
                    ? 'This device has no Pod yet. Create one to store data here.'
                    : 'No Pods found. Create one to get started.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {pods.map((pod) => (
                  <li key={pod.id} className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <Database className={iconMutedClass} />
                      <div className="min-w-0">
                        <a href={pod.id} target="_blank" rel="noopener" className={`${linkClass} block`}>{pod.id}</a>
                        {pod.name && (
                          <p className="text-[11px] text-muted-foreground truncate">Pod: {pod.name}</p>
                        )}
                      </div>
                    </div>
                    {pod.resourceUrl ? (
                      <button onClick={() => handleDeletePod(pod)} className={dangerButtonClass} title="Delete Pod">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* WebIDs Section */}
        <section>
          <div className="flex items-center mb-1">
            <h2 className={sectionTitleClass}><User className="w-4 h-4 text-primary" />Identity</h2>
          </div>
          <p className="text-[11px] text-muted-foreground mb-3">Your unique decentralized identifiers (WebIDs). This is your identity on the Solid network.</p>
          <div className={cardClass}>
            {webIds.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No WebIDs found. Create a Pod first to get a WebID.</p>
            ) : (
              <ul className="divide-y divide-border">
                {webIds.map((id) => (
                  <li key={id} className="p-3 flex items-center gap-3">
                    <Globe className={iconMutedClass} />
                    <a href={id} target="_blank" rel="noopener" className={linkClass}>{id}</a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Client Credentials Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className={sectionTitleClass}><Key className="w-4 h-4 text-primary" />Solid Client Credentials</h2>
            {accountClientCredentialsUrl && (
              <button onClick={openCreateCredential} disabled={isLoading} className={`flex items-center gap-1.5 px-3 py-1.5 ${primaryButtonClass} text-xs rounded-lg`}>
                <Plus className="w-3.5 h-3.5" />New Credential
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mb-3">
            Solid credentials for clients that need direct Pod access. Xpod API Keys are managed in AI Connections.
          </p>
          
          {!accountClientCredentialsUrl ? (
            <div className={`${cardClass} p-4`}>
              <p className="text-xs text-muted-foreground">Client credential endpoint not configured.</p>
            </div>
          ) : (
            <>
              {showCreateCredential && (
                <form onSubmit={handleCreateCredential} className={`mb-4 p-4 ${cardClass} space-y-3`}>
                  <div>
                    <label className={labelClass}>Credential Name</label>
                    <input
                      type="text"
                      value={credentialName}
                      onChange={(e) => setCredentialName(e.target.value)}
                      placeholder="my-solid-client"
                      className={`w-full px-3 py-2 ${inputClass}`}
                      required
                    />
                  </div>
                  <div>
                    <label className={labelClass}>WebID</label>
                    <div className="relative" ref={dropdownRef}>
                      <button
                        type="button"
                        onClick={() => setShowWebIdDropdown(!showWebIdDropdown)}
                        className={`w-full px-3 py-2 ${inputClass} text-left flex items-center justify-between`}
                      >
                        <span className="truncate text-foreground">{credentialWebId || 'Select WebID'}</span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${showWebIdDropdown ? 'rotate-180' : ''}`} />
                      </button>
                      {showWebIdDropdown && (
                        <div className="absolute z-10 mt-1 w-full bg-popover text-popover-foreground border border-border rounded-lg shadow-lg max-h-48 overflow-auto">
                          {webIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                setCredentialWebId(id);
                                setShowWebIdDropdown(false);
                              }}
                              className={`w-full px-3 py-2 text-left text-sm hover:bg-muted truncate ${credentialWebId === id ? 'bg-primary/10 text-primary' : 'text-foreground'}`}
                            >
                              {id}
                            </button>
                          ))}
                        </div>
                      )}
                      <input type="hidden" name="webId" value={credentialWebId} required />
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setShowCreateCredential(false)} className="px-3 py-2 text-muted-foreground hover:text-foreground text-xs">Cancel</button>
                    <button type="submit" disabled={isLoading} className={`px-4 py-2 ${primaryButtonClass} text-xs rounded-lg`}>{isLoading ? 'Creating...' : 'Create'}</button>
                  </div>
                </form>
              )}

              {newCredential && (
                <div className="mb-4 p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-emerald-500/15 rounded-lg"><Key className="w-4 h-4 text-emerald-600 dark:text-emerald-300" /></div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-1">New Solid Client Credential Created</p>
                      <p className="text-xs text-muted-foreground mb-3">Copy the Client ID and Client Secret now. The secret will not be shown again.</p>
                      <div className="space-y-3 text-xs font-mono bg-card p-3 rounded-lg border border-border">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-muted-foreground select-none">Client ID</span>
                            <p className="text-foreground truncate">{newCredential.id}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(newCredential.id, 'id')}
                            className={copyButtonClass}
                            title="Copy Client ID"
                          >
                            {copiedField === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-muted-foreground select-none">Client Secret</span>
                            <p className="text-foreground break-all">{newCredential.secret}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(newCredential.secret, 'secret')}
                            className={copyButtonClass}
                            title="Copy Client Secret"
                          >
                            {copiedField === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                      <button onClick={() => setNewCredential(null)} className="mt-2 text-xs text-muted-foreground hover:text-foreground font-medium">Done</button>
                    </div>
                  </div>
                </div>
              )}
              
              <div className={cardClass}>
                {credentials.length === 0 ? (
                  <p className="p-4 text-xs text-muted-foreground">No client credentials found.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {credentials.map((cred) => (
                      <li key={cred.id} className="p-3 flex items-center justify-between">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <Key className={iconMutedClass} />
                          <span className="text-xs font-mono text-foreground truncate">{cred.id}</span>
                        </div>
                        <button onClick={() => handleDeleteCredential(cred)} className={dangerButtonClass} title="Revoke Credential">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>

        {/* Security Section */}
        <section>
          <h2 className={`${sectionTitleClass} mb-3`}><Shield className="w-4 h-4 text-primary" />Security</h2>
          <div className={`${cardClass} p-4 flex items-center justify-between`}>
            <div>
              <h3 className="text-xs font-medium mb-1">Password</h3>
              <p className="text-[10px] text-muted-foreground">Update your account password</p>
            </div>
            <a href={passwordForgotUrl} className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs rounded-lg transition-colors">
              Change Password
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
