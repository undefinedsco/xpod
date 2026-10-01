import { scopeAccountUrl } from '../utils/account-interaction-url';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { LogOut, Key, Copy, Check, ChevronDown, Info, AlertCircle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContextValue';
import {
  clearStoredProvisionCode,
  getStoredProvisionCode,
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
import {
  resolveXpodAccountPageLocale,
  xpodAccountDashboardCopy,
  xpodFirstPodErrors,
} from '../auth/xpod-account-copy';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import {
  ConsentResumeBanner,
  CredentialSection,
  IdpChrome,
  Input,
  WebIdSection,
  resolvePodSignInCopy,
  webIdShortName,
  type CredentialEntry,
  type StorageLocation,
  type UnlinkedPodEntry,
  type WebIdEntry,
} from '@undefineds.co/shared-ui';
import { fetchOidcCancelRedirectLocation, resolveOidcCancelUrl } from './ConsentPage.utils';
import {
  clearConsentContinuation,
  clearManagementContinuation,
  currentInteractionScope,
  resolveAuthoritativeAccountId,
  saveConsentContinuation,
  saveManagementContinuation,
} from '../utils/safe-continuation';

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

/**
 * One Pod is described by two authority sources: the durable bindings listing
 * (WebID → storage URL, no management address) and the Pod inventory
 * (storage URL → the resource address that owns it). They key off the same
 * storage URL, so merge both facts onto one row instead of dropping the
 * duplicate. The inventory is the only source of the advertised management
 * address; losing it silently removed the Pod's delete action from the page.
 */
function mergePodsByStorageUrl(existing: PodView[], incoming: PodView[]): PodView[] {
  const byId = new Map(existing.map((pod) => [pod.id, pod] as const));
  for (const pod of incoming) {
    const current = byId.get(pod.id);
    if (!current) {
      byId.set(pod.id, pod);
      continue;
    }
    byId.set(pod.id, {
      ...current,
      resourceUrl: pod.resourceUrl ?? current.resourceUrl,
      name: current.name ?? pod.name,
      storageMode: current.storageMode ?? pod.storageMode,
    });
  }
  return Array.from(byId.values());
}

/**
 * Carry the inventory's advertised management address onto a Pod row that came
 * from a different authority source. The local provision scope only filters
 * which storage URLs may show; it must not discard the management fact the
 * account inventory already advertised for the same storage URL. A Pod with no
 * advertised address keeps none — the address is never guessed.
 */
function attachInventoryManagement(pod: PodView, inventory: PodView[]): PodView {
  const match = inventory.find((candidate) => candidate.id === pod.id && candidate.resourceUrl);
  return match ? { ...pod, resourceUrl: match.resourceUrl } : pod;
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

const cardClass = 'bg-card border border-border rounded-xl shadow-sm';
const labelClass = 'block text-sm text-muted-foreground mb-1';
const primaryButtonClass = 'bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-50';
const quietButtonClass = 'text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors';
const inputClass = 'bg-background border border-input rounded-lg text-sm text-foreground focus:border-primary focus:outline-none';
const copyButtonClass = 'p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors shrink-0';

export function AccountPage({ locale }: { locale?: string } = {}) {
  const { bindAccountCapability, controls, refetchControls, hasOidcPending, idpIndex, identity } = useAuth();
  const copy = xpodAccountDashboardCopy(resolveXpodAccountPageLocale(locale));
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [pods, setPods] = useState<PodView[]>([]);
  const [bindings, setBindings] = useState<StorageBinding[]>([]);
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
    ?? scopeAccountUrl('/.account/login/password/forgot/');

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

  const handleManagePods = useCallback(() => {
    // Daily management entry. Only a genuinely pending authorization — both the
    // scoped route and the provider's own pending flag — carries the consent task
    // so the heavy page can offer the way back. A daily visit (or a bare
    // interaction-shaped URL with no pending authorization) stores only the
    // Account return address and must never fabricate an authorization task.
    const accountId = resolveAuthoritativeAccountId(controls, identity);
    const interaction = currentInteractionScope();
    if (accountId && interaction && hasOidcPending) {
      // This entry came from the authorization flow: that is the active intent,
      // so drop any daily-management context instead of letting the heavy page
      // offer two contradictory returns.
      clearManagementContinuation();
      saveConsentContinuation({ accountId, interaction, returnTo: `${interaction}/oidc/consent/` });
    } else if (accountId) {
      // A daily visit is the active intent. Any leftover consent record from an
      // earlier flow for this same Account must not override it on the heavy
      // page, which would send the user "back to authorization" they are not in.
      clearConsentContinuation();
      saveManagementContinuation({ accountId, returnTo: scopeAccountUrl('/.account/account/') });
    } else {
      // No authoritative Account id: never let a stale task from a previous
      // session ride along into the management page.
      clearConsentContinuation();
      clearManagementContinuation();
    }
    window.location.href = '/settings/pod';
  }, [controls, hasOidcPending, identity]);

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
      // Listing durable bindings is not a creation operation. An expired
      // creation hint must not block the CSS Account bindings endpoint.
      const provisionCode = getStoredProvisionCode();
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
        setBindings(bindings);
        allWebIds = bindings.map((entry) => entry.webId);
        allPods = podsFromScopedEntries(bindings.map((entry) => ({
          webId: entry.webId,
          storageUrl: entry.storageUrl,
          storageMode: storageModeFor(entry.webId, entry.storageUrl),
        })));
      } else {
        setBindings([]);
      }
      if (accountWebIdUrl) {
        const res = await fetch(scopeAccountUrl(accountWebIdUrl), { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountWebIdResponse;
          const links = json.webIdLinks || {};
          allWebIds = Array.from(new Set([...allWebIds, ...Object.keys(links)]));
        }
      }

      if (accountPodUrl) {
        const res = await fetch(scopeAccountUrl(accountPodUrl), { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as AccountPodResponse;
          allPods = mergePodsByStorageUrl(allPods, normalizePods(json));
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
        ? podsFromScopedEntries(scopedEntries).map((pod) => attachInventoryManagement(pod, allPods))
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
        const res = await fetch(scopeAccountUrl(accountClientCredentialsUrl), { headers: storedAccountTokenHeaders(), credentials: 'include' });
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
      const res = await fetch(scopeAccountUrl(accountLogoutUrl), {
        method: 'POST',
        headers: storedAccountTokenHeaders(),
        credentials: 'include',
      });
      if (res.ok) {
        clearStoredProvisionCode();
        clearAccountSessionToken();
        await refetchControls();
        navigate(scopeAccountUrl('/.account/'));
      } else {
        setAccountError('退出登录失败，请重试。');
      }
    } catch (err: unknown) {
      setAccountError(accountActionError(err, '退出登录失败，请重试。'));
    } finally {
      setIsLoading(false);
    }
  };


  const handleDeletePod = async (pod: PodView) => {
    const podResourceUrl = await resolveHostedAccountControlUrl(pod.resourceUrl, fetch, idpIndex);
    if (!podResourceUrl) return;
    if (!confirm(copy.deletePodConfirm(pod.id))) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(scopeAccountUrl(podResourceUrl), { method: 'DELETE', headers: storedAccountTokenHeaders(), credentials: 'include' });
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
      const res = await fetch(scopeAccountUrl(accountClientCredentialsUrl), {
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
    if (!confirm(copy.deleteCredentialConfirm)) return;
    setIsLoading(true);
    setAccountError(null);
    try {
      const res = await fetch(scopeAccountUrl(credentialResourceUrl), { method: 'DELETE', headers: storedAccountTokenHeaders(), credentials: 'include' });
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

  const accountLocale = resolveXpodAccountPageLocale(locale);
  const signInCopy = resolvePodSignInCopy(accountLocale);
  const pendingInteraction = currentInteractionScope();
  // Only the provider's own pending flag, together with this page's scoped
  // interaction, is proof an authorization is still live. A bare
  // interaction-shaped URL must never fabricate a resume task.
  const showPendingBanner = hasOidcPending && Boolean(pendingInteraction);

  const storageLocationFor = (webId: string, storageUrl: string | undefined): StorageLocation | undefined => {
    if (!storageUrl) return undefined;
    const mode = pods.find((pod) => pod.id === storageUrl)?.storageMode ?? storageModeFor(webId, storageUrl);
    if (mode === 'cloud') return { kind: 'cloud', label: signInCopy.deviceCloud };
    if (mode === 'local') return { kind: 'edge', label: signInCopy.deviceEdge };
    // 'custom' is not one of the public classifications; leave it unclassified
    // instead of guessing a location.
    return undefined;
  };

  const podForWebId = (webId: string): PodView | undefined => {
    const storageUrl = bindings.find((item) => item.webId === webId)?.storageUrl;
    return storageUrl ? pods.find((pod) => pod.id === storageUrl) : undefined;
  };

  const webIdEntries: WebIdEntry[] = webIds.map((webId) => {
    const storageUrl = bindings.find((item) => item.webId === webId)?.storageUrl;
    const pod = storageUrl ? pods.find((item) => item.id === storageUrl) : undefined;
    return {
      id: webId,
      displayName: webIdShortName(webId),
      webId,
      podUrl: storageUrl,
      ...(storageLocationFor(webId, storageUrl) ? { storage: storageLocationFor(webId, storageUrl)! } : {}),
      removable: Boolean(pod?.resourceUrl),
    };
  });
  // Real Pods that the account advertises but that have no WebID binding must
  // stay visible: they are genuine storage, and hiding them would drop the
  // only management action the account advertises. No WebID link is invented.
  const linkedStorageUrls = new Set(bindings.map((item) => item.storageUrl));
  const unlinkedPodEntries: UnlinkedPodEntry[] = pods
    .filter((pod) => !linkedStorageUrls.has(pod.id))
    .map((pod) => ({
      id: pod.id,
      storageUrl: pod.id,
      displayName: pod.name ?? pod.id,
      ...(pod.storageMode === 'cloud' || pod.storageMode === 'local'
        ? { storage: pod.storageMode === 'cloud'
            ? { kind: 'cloud' as const, label: signInCopy.deviceCloud }
            : { kind: 'edge' as const, label: signInCopy.deviceEdge } }
        : {}),
      removable: Boolean(pod.resourceUrl),
    }));
  const webIdLabelById = new Map(webIdEntries.map((entry) => [entry.id, entry.displayName]));
  const credentialEntries: CredentialEntry[] = credentials.map((credential) => ({
    id: credential.id,
    label: credential.id,
    webIdName: credential.webId
      ? webIdLabelById.get(credential.webId) ?? webIdShortName(credential.webId)
      : '',
  }));

  const handleRemoveWebIdEntry = (entry: WebIdEntry) => {
    const pod = podForWebId(entry.id);
    if (pod) void handleDeletePod(pod);
  };

  const handleRemoveUnlinkedPod = (entry: UnlinkedPodEntry) => {
    const pod = pods.find((item) => item.id === entry.id);
    if (pod) void handleDeletePod(pod);
  };

  /**
   * The banner actions capture the current Account capability exactly once and
   * re-check it after every await: a switch that lands while the server call is
   * in flight must not clear the new session's task or navigate this tab to the
   * old client. The authoritative Account id and interaction scope are re-read
   * at the same time, so a stale banner never resumes an old task.
   */
  const assertActionSession = useCallback((
    expectedAccountId: string,
    expectedInteraction: string,
    assertAccount: (() => void) | undefined,
  ) => {
    assertAccount?.();
    const currentAccountId = resolveAuthoritativeAccountId(controls, identity);
    if (!currentAccountId
      || currentAccountId !== expectedAccountId
      || currentInteractionScope() !== expectedInteraction) {
      throw new Error('xpod-account-session-changed');
    }
  }, [controls, identity]);

  const handleContinuePendingAuthorization = useCallback(() => {
    if (!pendingInteraction) return;
    const expectedAccountId = resolveAuthoritativeAccountId(controls, identity);
    if (!expectedAccountId) {
      setAccountError(copy.authorizationUnavailable);
      return;
    }
    try {
      assertActionSession(expectedAccountId, pendingInteraction, bindAccountCapability?.());
    } catch {
      setAccountError(copy.authorizationUnavailable);
      return;
    }
    navigate(`${pendingInteraction}/oidc/consent/`);
  }, [assertActionSession, bindAccountCapability, controls, copy.authorizationUnavailable, identity, navigate, pendingInteraction]);

  const handleCancelPendingAuthorization = useCallback(async () => {
    if (!pendingInteraction) return;
    const expectedAccountId = resolveAuthoritativeAccountId(controls, identity);
    if (!expectedAccountId) {
      setAccountError(copy.authorizationUnavailable);
      return;
    }
    // One capability closure for the whole call; never re-bind the new session.
    const assertAccount = bindAccountCapability?.();
    setIsLoading(true);
    setAccountError(null);
    try {
      assertActionSession(expectedAccountId, pendingInteraction, assertAccount);
      const redirect = await fetchOidcCancelRedirectLocation({
        cancelUrl: scopeAccountUrl(resolveOidcCancelUrl(controls, idpIndex)),
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      assertActionSession(expectedAccountId, pendingInteraction, assertAccount);
      clearConsentContinuation();
      window.location.assign(scopeAccountUrl(redirect));
    } catch {
      // A failed cancel must stay retryable and must not pretend the
      // authorization was cancelled.
      setAccountError(copy.cancelAuthorizationFailed);
      setIsLoading(false);
    }
  }, [assertActionSession, bindAccountCapability, controls, copy.authorizationUnavailable, copy.cancelAuthorizationFailed, identity, idpIndex, pendingInteraction]);

  return (
    <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
      <IdpChrome
        serviceName={copy.brandName}
        serviceHost={typeof window !== 'undefined' ? window.location.host : undefined}
        locale={accountLocale}
      />
      <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-6 px-4 py-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold text-foreground">{copy.dashboardTitle}</h1>
          <div className="flex items-center gap-1">
            <Link to={scopeAccountUrl('/.account/about/')} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm ${quietButtonClass}`}>
              <Info className="w-3.5 h-3.5" />
              {copy.about}
            </Link>
            <button type="button" onClick={handleLogout} disabled={isLoading} className={`flex items-center gap-2 px-3 py-1.5 text-sm ${quietButtonClass}`}>
              <LogOut className="w-3.5 h-3.5" />
              {copy.signOut}
            </button>
          </div>
        </div>

        {accountError ? (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm leading-5">{accountError}</p>
            <button
              type="button"
              onClick={() => setAccountError(null)}
              className="rounded p-1 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={copy.closeError}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        {showPendingBanner ? (
          <ConsentResumeBanner
            app={{ name: '' }}
            podReady={pods.length > 0}
            pending={isLoading}
            onContinue={handleContinuePendingAuthorization}
            onCancel={() => void handleCancelPendingAuthorization()}
            locale={accountLocale}
            copy={{
              resumeTitle: copy.authorizationPendingTitle,
              resumeWaiting: copy.authorizationPendingLead,
              resumeCancel: copy.cancelAuthorization,
              resumeContinue: copy.continueAuthorization,
            }}
          />
        ) : null}

        <WebIdSection
          webIds={webIdEntries}
          locale={accountLocale}
          onCreateExternal={accountPodUrl ? handleManagePods : undefined}
          createExternalLabel={copy.managePods}
          onRemoveStorage={handleRemoveWebIdEntry}
          removeStorageLabel={copy.deletePod}
          unlinkedPods={unlinkedPodEntries}
          onRemoveUnlinkedPod={handleRemoveUnlinkedPod}
        />
        {webIds.length > 0 && pods.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{copy.noPodOnDevice}</p>
        ) : null}

        {accountClientCredentialsUrl ? (
          <>
            <CredentialSection
              credentials={credentialEntries}
              canCreate={webIds.length > 0 && !isLoading}
              onCreate={openCreateCredential}
              onRevoke={(credentialId) => {
                const credential = credentials.find((item) => item.id === credentialId);
                if (credential) void handleDeleteCredential(credential);
              }}
              locale={accountLocale}
              copy={{
                credentialSectionTitle: copy.credentialsTitle,
                credentialSectionHint: copy.credentialsLead,
                createCredential: copy.newCredential,
                credentialEmpty: copy.noCredentials,
                revokeCredential: copy.revokeCredential,
              }}
            />

            {showCreateCredential ? (
              <form onSubmit={handleCreateCredential} className={`${cardClass} space-y-3 p-4`}>
                <div>
                  <label className={labelClass} htmlFor="account-credential-name">{copy.credentialName}</label>
                  <Input
                    id="account-credential-name"
                    name="credentialName"
                    type="text"
                    value={credentialName}
                    onChange={(e) => setCredentialName(e.target.value)}
                    placeholder="my-solid-client"
                    required
                  />
                </div>
                <div>
                  <label className={labelClass}>WebID</label>
                  <div className="relative" ref={dropdownRef}>
                    <button
                      type="button"
                      onClick={() => setShowWebIdDropdown(!showWebIdDropdown)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left ${inputClass}`}
                    >
                      <span className="truncate text-foreground">{credentialWebId || copy.selectWebId}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${showWebIdDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showWebIdDropdown && (
                      <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
                        {webIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              setCredentialWebId(id);
                              setShowWebIdDropdown(false);
                            }}
                            className={`w-full truncate px-3 py-2 text-left text-sm hover:bg-muted ${credentialWebId === id ? 'bg-primary/10 text-primary' : 'text-foreground'}`}
                          >
                            {id}
                          </button>
                        ))}
                      </div>
                    )}
                    <input type="hidden" name="webId" value={credentialWebId} required />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowCreateCredential(false)} className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground">{copy.cancel}</button>
                  <button type="submit" disabled={isLoading} className={`rounded-lg px-4 py-2 text-sm ${primaryButtonClass}`}>{isLoading ? copy.creating : copy.create}</button>
                </div>
              </form>
            ) : null}

            {newCredential ? (
              <div className="rounded-xl border border-primary/30 bg-primary/10 p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/15 p-2"><Key className="w-4 h-4 text-primary" /></div>
                  <div className="flex-1">
                    <p className="mb-1 text-sm font-medium text-primary">{copy.credentialCreated}</p>
                    <p className="mb-3 text-sm text-muted-foreground">{copy.credentialCreatedLead}</p>
                    <div className="space-y-3 rounded-lg border border-border bg-card p-3 font-mono text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="select-none text-muted-foreground">{copy.clientId}</span>
                          <p className="truncate text-foreground">{newCredential.id}</p>
                        </div>
                        <button onClick={() => copyToClipboard(newCredential.id, 'id')} className={copyButtonClass} title={copy.copyClientId}>
                          {copiedField === 'id' ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="select-none text-muted-foreground">{copy.clientSecret}</span>
                          <p className="break-all text-foreground">{newCredential.secret}</p>
                        </div>
                        <button onClick={() => copyToClipboard(newCredential.secret, 'secret')} className={copyButtonClass} title={copy.copyClientSecret}>
                          {copiedField === 'secret' ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                    <button onClick={() => setNewCredential(null)} className="mt-2 text-xs font-medium text-muted-foreground hover:text-foreground">{copy.done}</button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <section aria-label={copy.credentialsTitle} className={`${cardClass} p-4`}>
            <p className="text-sm text-muted-foreground">{copy.credentialEndpointMissing}</p>
          </section>
        )}

        <section aria-label={copy.securityTitle} className={`${cardClass} flex items-center justify-between p-4`}>
          <div>
            <h2 className="mb-1 text-sm font-medium text-foreground">{copy.passwordLabel}</h2>
            <p className="text-[13px] text-muted-foreground">{copy.passwordLead}</p>
          </div>
          <a href={passwordForgotUrl} className="rounded-lg bg-secondary px-3 py-1.5 text-sm text-secondary-foreground transition-colors hover:bg-secondary/80">
            {copy.changePassword}
          </a>
        </section>
      </main>
    </div>
  );
}
