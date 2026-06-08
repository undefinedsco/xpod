import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, AlertCircle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';
import { FirstPodCreator } from '../components/FirstPodCreator';
import { persistReturnTo } from '../utils/returnTo';
import { clearAccountSessionToken, storedAccountTokenHeaders } from '../utils/account-session';
import { getStoredProvisionCode, resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { lookupProvisionScopedWebIds } from '../utils/provision-scope';

export function ConsentPage() {
  const { idpIndex, isLoggedIn, controls } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [clientInfo, setClientInfo] = useState<any>(null);
  const [currentWebId, setCurrentWebId] = useState<string | null>(null);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [selectedWebId, setSelectedWebId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [rememberClient, setRememberClient] = useState(true);
  const [provisionCode, setProvisionCode] = useState<string | undefined>(() => getStoredProvisionCode());
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const consentUrl = `${idpIndex}oidc/consent/`;
  const pickWebIdUrl = `${idpIndex}oidc/pick-webid/`;
  const cancelUrl = resolveOidcCancelUrl(controls, idpIndex);

  const refreshConsentState = async (): Promise<string[]> => {
    const currentProvisionCode = await resolveProvisionCodeForCurrentScope(fetch, provisionCode);
    setProvisionCode(currentProvisionCode);

    const consentRes = await fetch(consentUrl, {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });

    console.log('[Consent] GET consent response status:', consentRes.status);

    if (consentRes.status === 401 || consentRes.status === 403) {
      setError('Please sign in to continue authorization.');
      return [];
    }
    if (!consentRes.ok) {
      const errJson = await consentRes.json().catch(() => ({}));
      throw new Error(errJson.message || 'Failed to load consent info');
    }

    const consentData = await consentRes.json();
    setClientInfo(consentData.client || {});
    setCurrentWebId(consentData.webId || null);

    const pickRes = await fetch(pickWebIdUrl, {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });
    if (!pickRes.ok) {
      setWebIds([]);
      setSelectedWebId('');
      return [];
    }

    const pickData = await pickRes.json();
    const rawIds = Array.isArray(pickData.webIds)
      ? pickData.webIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const scopedEntries = currentProvisionCode
      ? await lookupProvisionScopedWebIds(fetch, rawIds, currentProvisionCode)
      : undefined;
    const ids = scopedEntries
      ? scopedEntries.map((entry) => entry.webId)
      : rawIds;
    setWebIds(ids);
    if (consentData.webId && ids.includes(consentData.webId)) {
      setSelectedWebId(consentData.webId);
    } else if (ids.length > 0) {
      setSelectedWebId(ids[0]);
    } else {
      setSelectedWebId('');
    }

    return ids;
  };

  useEffect(() => {
    console.log('[Consent] Page loaded, fetching consent info...');
    persistReturnTo(window.location.href);
    (async () => {
      try {
        await refreshConsentState();
      } catch (err: any) {
        setError(err.message || 'Failed to load consent info');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [consentUrl, pickWebIdUrl]);

  const parseWebIdInfo = (webId: string): { provider: string; podId: string; full: string } => {
    try {
      const url = new URL(webId);
      const segments = url.pathname.split('/').filter(Boolean);
      return { provider: url.host, podId: segments[0] ?? '-', full: webId };
    } catch {
      return { provider: '-', podId: '-', full: webId };
    }
  };

  const copyWebId = async (webId: string) => {
    try {
      await navigator.clipboard.writeText(webId);
      setCopyState(webId);
      setTimeout(() => setCopyState(null), 1200);
    } catch {
      setCopyState(null);
    }
  };

  // Switch to a different account (logout + redirect to login)
  const handleSwitchAccount = async () => {
    try {
      if (controls?.account?.logout) {
        await fetch(controls.account.logout, { method: 'POST', headers: storedAccountTokenHeaders(), credentials: 'include' });
      }
      clearAccountSessionToken();
      window.location.href = '/.account/login/password/';
    } catch {
      window.location.href = '/.account/login/password/';
    }
  };

  const handleConsent = async (allow: boolean) => {
    console.log('[Consent] handleConsent called, allow:', allow);
    if (!allow) {
      await handleCancelConsent();
      return;
    }

    try {
      setIsAuthorizing(true);
      setError(null);

      if (selectedWebId && selectedWebId !== currentWebId) {
        console.log('[Consent] Picking WebID:', selectedWebId);
        const pickRes = await fetch(pickWebIdUrl, {
          method: 'POST',
          headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ webId: selectedWebId, remember: false })
        });
        const pickJson = await pickRes.json();
        if (!pickRes.ok) {
          throw new Error(pickJson.message || 'Failed to select WebID');
        }
        if (pickJson.location) {
          await fetch(pickJson.location, { credentials: 'include' });
        }
      }

      const consentRes = await fetch(consentUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ remember: rememberClient })
      });
      const consentJson = await consentRes.json();
      console.log('[Consent] Response:', consentRes.status, consentJson);
      console.log('[Consent] Location header:', consentRes.headers.get('Location'));
      
      if (!consentRes.ok) {
        throw new Error(consentJson.message || 'Consent failed');
      }

      // Try to get redirect location from response
      const headerLocation = consentRes.headers.get('Location');
      const redirectUrl = consentJson.location || headerLocation;
      
      console.log('[Consent] Redirect URL:', redirectUrl);
      
      if (redirectUrl) {
        window.location.href = redirectUrl;
      } else {
        // No redirect URL - authorization complete but nowhere to go
        // This might happen if the OIDC session was lost
        setError('Authorization completed but no redirect URL received. The application may need to restart the login flow.');
        setIsLoading(false);
      }
    } catch (err: any) {
      setError(err.message || 'Consent failed');
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleCancelConsent = async () => {
    console.log('[Consent] Cancelling...');
    try {
      setIsCancelling(true);
      setError(null);
      const redirectUrl = await fetchOidcCancelRedirectLocation({
        cancelUrl,
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      window.location.href = redirectUrl;
    } catch (err: any) {
      setError(err.message || 'Authorization cancellation failed');
    } finally {
      setIsCancelling(false);
    }
  };

  const displayWebIds = resolveConsentDisplayWebIds(webIds, currentWebId, Boolean(provisionCode));
  const isSubmitting = isAuthorizing || isCancelling;

  return (
    <CardWrapper title="Authorize" subtitle={`${clientInfo?.client_name || 'Application'} requests access`} icon={Shield}>
      {!isLoggedIn && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-3 text-zinc-600 text-[11px] space-y-3">
          <p>Sign in to approve this request and choose which WebID to share.</p>
          <button
            onClick={() => {
              persistReturnTo(window.location.href);
              navigate('/.account/login/password/');
            }}
            className="w-full py-2.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-xs font-medium"
          >
            Go to Sign in
          </button>
        </div>
      )}
      
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-red-600 text-[11px]">
          <AlertCircle className="w-4 h-4 inline mr-2" />{error}
        </div>
      )}
      
      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-6 h-6 animate-spin text-[#7C4DFF]" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Client info */}
          {(clientInfo?.client_uri || clientInfo?.client_id) && (
            <div className="text-center text-[11px] text-zinc-500 space-y-1">
              {clientInfo?.client_uri && (
                <div>
                  <a href={clientInfo.client_uri} target="_blank" rel="noopener" className="text-[#7C4DFF] hover:text-[#6B3FE8]">
                    {clientInfo.client_uri}
                  </a>
                </div>
              )}
              {clientInfo?.client_id && (
                <div className="text-[10px] text-zinc-400 truncate" title={clientInfo.client_id}>
                  ID: {clientInfo.client_id}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                Sign in as
              </label>
              {displayWebIds.length > 0 && (
                <div className="text-[10px] text-zinc-500">
                  Provider: <span className="text-zinc-600">{parseWebIdInfo(displayWebIds[0]).provider}</span>
                </div>
              )}
            </div>
            {displayWebIds.length === 0 ? (
              <FirstPodCreator
                createPodUrl={controls?.account?.pod}
                headers={storedAccountTokenHeaders()}
                onCreated={async (ids) => {
                  if (ids.length === 0) {
                    await refreshConsentState();
                    setError('Storage was created. Click Refresh authorization when the WebID is ready.');
                    return;
                  }
                  setWebIds(ids);
                  setSelectedWebId(ids[0] || '');
                }}
                onError={setError}
                pickWebIdUrl={pickWebIdUrl}
                provisionCode={provisionCode}
                webIdCandidates={[currentWebId]}
              />
            ) : (
              <div className="space-y-1">
                {displayWebIds.map(id => {
                  const info = parseWebIdInfo(id);
                  return (
                    <label 
                      key={id} 
                      className={clsx(
                        "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors",
                        selectedWebId === id 
                          ? "border-[#7C4DFF]/50 bg-[#7C4DFF]/10" 
                          : "border-zinc-200 bg-zinc-50 hover:border-zinc-300"
                      )}
                    >
                      <input 
                        type="radio" 
                        name="webId" 
                        value={id} 
                        checked={selectedWebId === id} 
                        onChange={e => setSelectedWebId(e.target.value)} 
                        className="text-[#7C4DFF]" 
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-zinc-700 truncate" title={info.full}>
                          {info.podId}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          copyWebId(id);
                        }}
                        className="px-2 py-1 text-[10px] rounded-lg border border-zinc-300 text-zinc-600 hover:text-zinc-900 hover:border-[#7C4DFF]/50 shrink-0"
                      >
                        {copyState === id ? 'Copied' : 'Copy'}
                      </button>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Remember this client checkbox */}
          <label className="flex items-center gap-2 text-xs text-zinc-600 cursor-pointer">
            <input 
              type="checkbox" 
              checked={rememberClient} 
              onChange={e => setRememberClient(e.target.checked)}
              className="rounded border-zinc-300 text-[#7C4DFF] focus:ring-[#7C4DFF]"
            />
            Remember this client
          </label>

          {/* Main action buttons */}
          <div className="grid grid-cols-2 gap-3 pt-2">
            <button 
              onClick={() => handleConsent(false)} 
              disabled={isSubmitting}
              className="py-2.5 border border-zinc-200 rounded-xl text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 transition-colors"
            >
              {isCancelling ? 'Denying...' : 'Deny'}
            </button>
            <button 
              onClick={() => handleConsent(true)} 
              disabled={isSubmitting || displayWebIds.length === 0}
              className="py-2.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-xs disabled:opacity-50 transition-colors"
            >
              {isAuthorizing ? 'Authorizing...' : 'Authorize'}
            </button>
          </div>

          {/* Secondary action buttons */}
          <div className="flex justify-center gap-4 pt-2 border-t border-zinc-100">
            <button
              type="button"
              onClick={() => {
                persistReturnTo(window.location.href);
                navigate('/.account/account/');
              }}
              className="text-[11px] text-[#7C4DFF] hover:text-[#6B3FE8]"
            >
              Edit account
            </button>
            <button
              type="button"
              onClick={handleSwitchAccount}
              className="text-[11px] text-zinc-500 hover:text-zinc-700"
            >
              Use a different account
            </button>
          </div>
        </div>
      )}
    </CardWrapper>
  );
}

export function resolveConsentDisplayWebIds(
  scopedWebIds: string[],
  currentWebId: string | null,
  isProvisionScopedSession: boolean,
): string[] {
  if (scopedWebIds.length > 0) {
    return scopedWebIds;
  }

  // Local SP sessions must fail closed: currentWebId can be a Cloud account
  // selection from the issuer and is not proof that the selected SP owns a Pod.
  if (isProvisionScopedSession) {
    return [];
  }

  return currentWebId ? [currentWebId] : [];
}

export function resolveOidcCancelUrl(
  controls: { oidc?: { cancel?: string } } | null | undefined,
  fallbackIdpIndex: string,
): string {
  return controls?.oidc?.cancel || `${fallbackIdpIndex}oidc/cancel`;
}

export interface OidcCancelRedirectOptions {
  cancelUrl: string;
  headers?: HeadersInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchOidcCancelRedirectLocation(options: OidcCancelRedirectOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (controller) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchImpl(options.cancelUrl, {
      method: 'POST',
      headers: options.headers,
      credentials: 'include',
      body: JSON.stringify({}),
      signal: controller?.signal,
    });
    return await resolveOidcCancelRedirectLocation(res);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Authorization cancellation timed out. Please close this tab and retry login.');
    }
    throw err;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function resolveOidcCancelRedirectLocation(res: Response): Promise<string> {
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(readResponseMessage(json) || `Authorization cancellation failed (${res.status}).`);
  }

  const bodyLocation = isRecord(json) && typeof json.location === 'string' ? json.location.trim() : '';
  const headerLocation = res.headers.get('Location')?.trim() || '';
  const location = bodyLocation || headerLocation;
  if (!location) {
    throw new Error('Authorization cancellation did not return a redirect URL.');
  }
  return location;
}

function readResponseMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string' ? value.message : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
