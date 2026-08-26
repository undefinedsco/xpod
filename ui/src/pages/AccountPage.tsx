import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogOut, User, HardDrive, Key, Plus, Trash2, Globe, Database, Shield, Copy, Check, ChevronDown, Info, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContextValue';
import { buildPodCreatePayload, clearStoredProvisionCode, getStoredProvisionCode } from '../utils/pod';
import { clearAccountSessionToken, storedAccountTokenHeaders } from '../utils/account-session';
import {
  currentStorageScope,
  dedupeScopedEntries,
  scopedEntriesFromPods,
  storageUrlBelongsToRoot,
  type ScopedWebIdEntry,
  type StorageMode,
} from '../utils/storage-scope';

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

function derivePodNameFromWebId(webId: string): string | undefined {
  try {
    const segments = new URL(webId).pathname.split('/').filter(Boolean);
    const profileIndex = segments.indexOf('profile');
    return profileIndex > 0 ? segments[profileIndex - 1] : segments[0];
  } catch {
    return undefined;
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

function webIdsFromScopedEntries(entries: ScopedWebIdEntry[]): string[] {
  return Array.from(new Set(entries.map((entry) => entry.webId)));
}

function credentialIdFromUrl(resourceUrl: string): string {
  try {
    const segments = new URL(resourceUrl).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? resourceUrl;
  } catch {
    return resourceUrl.split('/').filter(Boolean).pop() ?? resourceUrl;
  }
}

/**
 * Generate API Key from client credentials.
 * Format: sk-{base64(client_id:client_secret)}
 */
function generateApiKey(clientId: string, clientSecret: string): string {
  const encoded = btoa(`${clientId}:${clientSecret}`);
  return `sk-${encoded}`;
}

function getAiApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'https://api.undefineds.co/v1';
  }

  const { protocol, hostname, origin } = window.location;

  if (hostname.startsWith('id.')) {
    return `${protocol}//api.${hostname.slice(3)}/v1`;
  }

  if (hostname.startsWith('api.')) {
    return `${origin}/v1`;
  }

  return `${origin.replace(/\/$/, '')}/v1`;
}

function accountActionError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  if (message.startsWith('Pod name is already taken.')) {
    return message;
  }
  if (message.includes('Local Xpod is temporarily unreachable')) {
    return '本机 Xpod 当前不可达。请确认它仍在后台运行后重试。';
  }
  if (
    message === 'fetch failed'
    || message.includes('Failed to fetch')
    || message.includes('NetworkError')
    || message.includes('Load failed')
  ) {
    return fallback;
  }
  return message || fallback;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { message?: unknown };
  return accountActionError(
    typeof body.message === 'string' ? body.message : undefined,
    fallback,
  );
}

export function AccountPage() {
  const { controls, refetchControls, hasOidcPending } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [pods, setPods] = useState<PodView[]>([]);
  const [localBindingMissing, setLocalBindingMissing] = useState(false);
  const [localBindingPodName, setLocalBindingPodName] = useState<string | null>(null);
  const [showCreatePod, setShowCreatePod] = useState(false);
  const [podName, setPodName] = useState('');
  const [showLinkWebId, setShowLinkWebId] = useState(false);
  const [linkWebIdUrl, setLinkWebIdUrl] = useState('');
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [newCredential, setNewCredential] = useState<{ id: string; secret: string } | null>(null);
  const [showCreateCredential, setShowCreateCredential] = useState(false);
  const [credentialWebId, setCredentialWebId] = useState('');
  const [credentialName, setCredentialName] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showWebIdDropdown, setShowWebIdDropdown] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const aiApiBaseUrl = getAiApiBaseUrl();

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
      const scope = currentStorageScope(window.location.origin, getStoredProvisionCode());
      let nextWebIds: string[] = [];
      let allWebIds: string[] = [];
      let allPods: PodView[] = [];
      let scopedEntries: ScopedWebIdEntry[] = [];
      if (controls?.account?.webId) {
        const res = await fetch(controls.account.webId, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountWebIdResponse;
          const links = json.webIdLinks || {};
          allWebIds = Object.keys(links);
        } else {
          // No WebIDs yet is normal for new users
          allWebIds = [];
        }
      }

      if (controls?.account?.pod) {
        const res = await fetch(controls.account.pod, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountPodResponse;
          allPods = normalizePods(json);
        } else {
          allPods = [];
        }
      }

      if (scope) {
        // Cloud account Pod records are the authority for the storage binding.
        // The browser must not call a Local Xpod directly; server-side
        // provisioning and consent own managed-route selection.
        scopedEntries = scopedEntriesFromPods(allWebIds, allPods.map((pod) => pod.id), scope);
        scopedEntries = dedupeScopedEntries(scopedEntries);
        nextWebIds = webIdsFromScopedEntries(scopedEntries);
      } else {
        nextWebIds = allWebIds;
      }
      const nextPods = scope
        ? allPods
          .filter((pod) => storageUrlBelongsToRoot(pod.id, scope.root))
          .map((pod) => ({
            ...pod,
            storageMode: scopedEntries.find((entry) => storageUrlBelongsToRoot(pod.id, entry.storageUrl))?.storageMode,
          }))
        : allPods;

      setWebIds(nextWebIds);
      setPods(nextPods);
      if (scope) {
        const missing = nextPods.length === 0 && allWebIds.length > 0;
        setLocalBindingMissing(missing);
        setLocalBindingPodName(missing ? derivePodNameFromWebId(allWebIds[0]) ?? null : null);
      } else {
        setLocalBindingMissing(false);
        setLocalBindingPodName(null);
      }

      if (controls?.account?.clientCredentials) {
        const res = await fetch(controls.account.clientCredentials, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountClientCredentialsResponse;
          const creds = json.clientCredentials || {};
          const scopedWebIds = new Set(nextWebIds);
          setCredentials(Object.entries(creds)
            .map(([resourceUrl, webId]) => ({
              id: credentialIdFromUrl(resourceUrl),
              resourceUrl,
              webId: typeof webId === 'string' ? webId : undefined,
            }))
            .filter((credential) => credential.webId && scopedWebIds.has(credential.webId)));
        } else {
          setCredentials([]);
        }
      } else {
        setCredentials([]);
      }
      setAccountError(null);
    } catch (err) {
      console.error('Failed to fetch account data:', err);
      setWebIds([]);
      setPods([]);
      setCredentials([]);
      setLocalBindingMissing(false);
      setLocalBindingPodName(null);
      setAccountError(accountActionError(err, '无法加载账号信息，请检查网络后重试。'));
    }
  }, [controls?.account?.clientCredentials, controls?.account?.pod, controls?.account?.webId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleLogout = async () => {
    if (!controls?.account?.logout) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(controls.account.logout, {
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
      setAccountError(accountActionError(err, '退出登录失败，请检查网络后重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreatePod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controls?.account?.pod || !podName.trim()) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(controls.account.pod, {
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
        setAccountError(await responseError(res, '无法创建存储空间，请检查名称或稍后重试。'));
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法创建存储空间，请检查网络后重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLinkWebId = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controls?.account?.webId || !linkWebIdUrl.trim()) return;
    if (getStoredProvisionCode()) {
      setShowLinkWebId(false);
      setAccountError('当前是本地存储作用域会话，暂不能绑定外部 WebID。');
      return;
    }
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(controls.account.webId, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ webId: linkWebIdUrl.trim() }),
      });
      if (res.ok) {
        setLinkWebIdUrl('');
        setShowLinkWebId(false);
        await fetchData();
      } else {
        setAccountError(await responseError(res, '无法绑定 WebID，请检查地址后重试。'));
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法绑定 WebID，请检查网络后重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRepairLocalBinding = async () => {
    const provisionCode = getStoredProvisionCode();
    if (!controls?.account?.pod || !provisionCode || !localBindingPodName) {
      setAccountError('缺少本机绑定信息。请从 Xpod 桌面端重新发起登录。');
      return;
    }

    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(controls.account.pod, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        body: JSON.stringify(buildPodCreatePayload(localBindingPodName, provisionCode)),
      });
      if (!res.ok) {
        setAccountError(await responseError(res, '无法修复本机存储绑定，请稍后重试。'));
        return;
      }

      await refetchControls();
      await fetchData();
      if (hasOidcPending) {
        navigate('/.account/oidc/consent/');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法修复本机存储绑定，请检查网络后重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeletePod = async (pod: PodView) => {
    if (!pod.resourceUrl) return;
    if (!confirm(`Delete pod ${pod.id}? This cannot be undone.`)) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(pod.resourceUrl, { method: 'DELETE', headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        await fetchData();
      } else {
        setAccountError('无法删除存储空间，请重试。');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法删除存储空间，请检查网络后重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateCredential = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controls?.account?.clientCredentials || !credentialWebId || !credentialName.trim()) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(controls.account.clientCredentials, {
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
      setAccountError(accountActionError(err, '无法创建客户端凭据，请检查网络后重试。'));
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
    if (!confirm('Delete this credential? This cannot be undone.')) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(credential.resourceUrl, { method: 'DELETE', headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        await fetchData();
      } else {
        setAccountError('无法撤销客户端凭据，请重试。');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '无法撤销客户端凭据，请检查网络后重试。'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-[#7C4DFF]/5 rounded-full blur-[120px]" />
      </div>
      <header className="relative z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#7C4DFF] rounded-lg flex items-center justify-center">
              <div className="w-4 h-4 border-2 border-white rounded opacity-80" />
            </div>
            <div>
              <div className="font-semibold leading-tight">Xpod</div>
              <div className="text-[10px] text-zinc-500 leading-tight">Personal Messages Platform</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/.account/about/" className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors">
              <Info className="w-3.5 h-3.5" />
              About
            </Link>
            <button onClick={handleLogout} disabled={isLoading} className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors">
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-8">
        {/* OIDC Authorization Pending Banner */}
        {hasOidcPending && (
          <div className="p-4 bg-[#7C4DFF]/10 border border-[#7C4DFF]/30 rounded-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#7C4DFF]/20 rounded-lg">
                  <Shield className="w-5 h-5 text-[#7C4DFF]" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-900">Authorization Pending</p>
                  <p className="text-xs text-zinc-500">An application is waiting for your authorization</p>
                </div>
              </div>
              <Link
                to="/.account/oidc/consent/"
                className="flex items-center gap-2 px-4 py-2 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-sm font-medium rounded-lg transition-colors"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        )}

        <h1 className="text-2xl font-bold">Account Dashboard</h1>

        {accountError && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-red-700">{accountError}</p>
              <button
                type="button"
                onClick={() => setAccountError(null)}
                className="text-xs font-medium text-red-600 hover:text-red-800"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Pods Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2"><HardDrive className="w-4 h-4 text-[#7C4DFF]" />Storage</h2>
            {controls?.account?.pod && (
              <button onClick={() => setShowCreatePod(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />Add Pod
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">Your personal data stores (Pods). You own and control all data stored here.</p>
          
          {showCreatePod && (
            <form onSubmit={handleCreatePod} className="mb-4 p-4 bg-white border border-zinc-200 rounded-xl shadow-sm">
              <label className="block text-xs text-zinc-500 mb-2">Pod Name</label>
              <div className="flex gap-2">
                <input type="text" value={podName} onChange={(e) => setPodName(e.target.value)} placeholder="my-pod" className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:border-[#7C4DFF] focus:outline-none" required />
                <button type="submit" disabled={isLoading} className="px-4 py-2 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg disabled:opacity-50">{isLoading ? 'Creating...' : 'Create'}</button>
                <button type="button" onClick={() => setShowCreatePod(false)} className="px-3 py-2 text-zinc-500 hover:text-zinc-900 text-xs">Cancel</button>
              </div>
            </form>
          )}
          <div className="bg-white border border-zinc-200 rounded-xl shadow-sm">
            {pods.length === 0 ? (
              <div className="p-4">
                {localBindingMissing ? (
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-medium text-zinc-700">本机存储尚未完成绑定</p>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        这通常会在首次登录时自动完成。确认本机 Xpod 仍在后台运行后，可从 Cloud 端重新建立绑定。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleRepairLocalBinding}
                      disabled={isLoading || !localBindingPodName}
                      className="px-3 py-2 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg disabled:opacity-50"
                    >
                      {isLoading ? '正在修复...' : '修复本机绑定'}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">No Pods found. Create one to get started.</p>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {pods.map((pod) => (
                  <li key={pod.id} className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <Database className="w-4 h-4 text-zinc-400 shrink-0" />
                      <div className="min-w-0">
                        <a href={pod.id} target="_blank" rel="noopener" className="text-xs font-mono text-[#7C4DFF] hover:text-[#6B3FE8] truncate block">{pod.id}</a>
                        {pod.name && (
                          <p className="text-[11px] text-zinc-500 truncate">Pod: {pod.name}</p>
                        )}
                      </div>
                    </div>
                    <button onClick={() => handleDeletePod(pod)} className="p-2 text-zinc-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete Pod">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* WebIDs Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2"><User className="w-4 h-4 text-[#7C4DFF]" />Identity</h2>
            {controls?.account?.webId && (
              <button onClick={() => setShowLinkWebId(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />Link WebID
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">Your unique decentralized identifiers (WebIDs). This is your identity on the Solid network.</p>
          
          {showLinkWebId && (
            <form onSubmit={handleLinkWebId} className="mb-4 p-4 bg-white border border-zinc-200 rounded-xl shadow-sm">
              <label className="block text-xs text-zinc-500 mb-2">WebID URL</label>
              <div className="flex gap-2">
                <input type="url" value={linkWebIdUrl} onChange={(e) => setLinkWebIdUrl(e.target.value)} placeholder="https://example.com/profile/card#me" className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:border-[#7C4DFF] focus:outline-none" required />
                <button type="submit" disabled={isLoading} className="px-4 py-2 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg disabled:opacity-50">{isLoading ? 'Linking...' : 'Link'}</button>
                <button type="button" onClick={() => setShowLinkWebId(false)} className="px-3 py-2 text-zinc-500 hover:text-zinc-900 text-xs">Cancel</button>
              </div>
            </form>
          )}
          <div className="bg-white border border-zinc-200 rounded-xl shadow-sm">
            {webIds.length === 0 ? (
              <p className="p-4 text-xs text-zinc-500">No WebIDs found. Create a Pod first to get a WebID.</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {webIds.map((id) => (
                  <li key={id} className="p-3 flex items-center gap-3">
                    <Globe className="w-4 h-4 text-zinc-400 shrink-0" />
                    <a href={id} target="_blank" rel="noopener" className="text-xs font-mono text-[#7C4DFF] hover:text-[#6B3FE8] truncate">{id}</a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* API Keys Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2"><Key className="w-4 h-4 text-[#7C4DFF]" />Developer Access</h2>
            {controls?.account?.clientCredentials && (
              <button onClick={openCreateCredential} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />New Key
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">
            AI API keys for model endpoints such as <code className="bg-zinc-100 px-1 py-0.5 rounded">/v1/chat/completions</code> and <code className="bg-zinc-100 px-1 py-0.5 rounded">/v1/responses</code>. Send as <code className="bg-zinc-100 px-1 py-0.5 rounded">Authorization: Bearer sk-xxx</code>.
          </p>
          
          {!controls?.account?.clientCredentials ? (
            <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-4">
              <p className="text-xs text-zinc-500">Client credential endpoint not configured.</p>
            </div>
          ) : (
            <>
              {showCreateCredential && (
                <form onSubmit={handleCreateCredential} className="mb-4 p-4 bg-white border border-zinc-200 rounded-xl shadow-sm space-y-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Key Name</label>
                    <input
                      type="text"
                      value={credentialName}
                      onChange={(e) => setCredentialName(e.target.value)}
                      placeholder="my-app-key"
                      className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:border-[#7C4DFF] focus:outline-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">WebID</label>
                    <div className="relative" ref={dropdownRef}>
                      <button
                        type="button"
                        onClick={() => setShowWebIdDropdown(!showWebIdDropdown)}
                        className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:border-[#7C4DFF] focus:outline-none text-left flex items-center justify-between"
                      >
                        <span className="truncate text-zinc-700">{credentialWebId || 'Select WebID'}</span>
                        <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${showWebIdDropdown ? 'rotate-180' : ''}`} />
                      </button>
                      {showWebIdDropdown && (
                        <div className="absolute z-10 mt-1 w-full bg-white border border-zinc-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                          {webIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                setCredentialWebId(id);
                                setShowWebIdDropdown(false);
                              }}
                              className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 truncate ${credentialWebId === id ? 'bg-[#7C4DFF]/10 text-[#7C4DFF]' : 'text-zinc-700'}`}
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
                    <button type="button" onClick={() => setShowCreateCredential(false)} className="px-3 py-2 text-zinc-500 hover:text-zinc-900 text-xs">Cancel</button>
                    <button type="submit" disabled={isLoading} className="px-4 py-2 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg disabled:opacity-50">{isLoading ? 'Creating...' : 'Create'}</button>
                  </div>
                </form>
              )}

              {newCredential && (
                <div className="mb-4 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-emerald-100 rounded-lg"><Key className="w-4 h-4 text-emerald-600" /></div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-emerald-700 mb-1">New API Key Created</p>
                      <p className="text-xs text-zinc-500 mb-3">Copy your API Key now. It will not be shown again.</p>
                      <div className="space-y-3 text-xs font-mono bg-white p-3 rounded-lg border border-zinc-200">
                        {/* Client ID */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-zinc-400 select-none">Client ID</span>
                            <p className="text-zinc-600 truncate">{newCredential.id}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(newCredential.id, 'id')}
                            className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors shrink-0"
                            title="Copy Client ID"
                          >
                            {copiedField === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        {/* Client Secret */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-zinc-400 select-none">Client Secret</span>
                            <p className="text-zinc-600 break-all">{newCredential.secret}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(newCredential.secret, 'secret')}
                            className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors shrink-0"
                            title="Copy Client Secret"
                          >
                            {copiedField === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        {/* API Key - the main thing users need */}
                        <div className="flex items-center justify-between gap-2 pt-3 border-t border-zinc-100">
                          <div className="min-w-0">
                            <span className="text-zinc-400 select-none">API Key</span>
                            <p className="text-emerald-600 break-all font-medium">{generateApiKey(newCredential.id, newCredential.secret)}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(generateApiKey(newCredential.id, newCredential.secret), 'apikey')}
                            className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors shrink-0"
                            title="Copy API Key"
                          >
                            {copiedField === 'apikey' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 text-xs">
                        <p className="mb-2 font-medium text-zinc-700">Usage</p>
                        <div className="space-y-2 font-mono text-[11px]">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <span className="text-zinc-400 select-none">Base URL</span>
                              <p className="break-all text-zinc-600">{aiApiBaseUrl}</p>
                            </div>
                            <button
                              onClick={() => copyToClipboard(aiApiBaseUrl, 'baseurl')}
                              className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors shrink-0"
                              title="Copy Base URL"
                            >
                              {copiedField === 'baseurl' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                          <div>
                            <span className="text-zinc-400 select-none">Authorization</span>
                            <p className="break-all text-zinc-600">Bearer {generateApiKey(newCredential.id, newCredential.secret)}</p>
                          </div>
                          <div>
                            <span className="text-zinc-400 select-none">Endpoints</span>
                            <p className="break-all text-zinc-600">/chat/completions · /responses · /models</p>
                          </div>
                        </div>
                      </div>
                      <button onClick={() => setNewCredential(null)} className="mt-2 text-xs text-zinc-500 hover:text-zinc-900 font-medium">Done</button>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="bg-white border border-zinc-200 rounded-xl shadow-sm">
                {credentials.length === 0 ? (
                  <p className="p-4 text-xs text-zinc-500">No API keys found.</p>
                ) : (
                  <ul className="divide-y divide-zinc-100">
                    {credentials.map((cred) => (
                      <li key={cred.id} className="p-3 flex items-center justify-between">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <Key className="w-4 h-4 text-zinc-400 shrink-0" />
                          <span className="text-xs font-mono text-zinc-600 truncate">{cred.id}</span>
                        </div>
                        <button onClick={() => handleDeleteCredential(cred)} className="p-2 text-zinc-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Revoke Key">
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
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2 mb-3"><Shield className="w-4 h-4 text-[#7C4DFF]" />Security</h2>
          <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-4 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-medium mb-1">Password</h3>
              <p className="text-[10px] text-zinc-500">Update your account password</p>
            </div>
            <a href={controls?.password?.forgot || '/.account/login/password/forgot/'} className="px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-xs rounded-lg transition-colors">
              Change Password
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
