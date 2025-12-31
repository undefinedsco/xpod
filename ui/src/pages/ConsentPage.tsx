import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, AlertCircle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';
import { persistReturnTo } from '../utils/returnTo';

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

  const consentUrl = `${idpIndex}oidc/consent/`;
  const pickWebIdUrl = `${idpIndex}oidc/pick-webid/`;
  const cancelUrl = `${idpIndex}oidc/cancel`;

  useEffect(() => {
    persistReturnTo(window.location.href);
    (async () => {
      try {
        const consentRes = await fetch(consentUrl, { 
          headers: { Accept: 'application/json' }, 
          credentials: 'include' 
        });
        
        if (consentRes.status === 401 || consentRes.status === 403) {
          setError('Please sign in to continue authorization.');
          setIsLoading(false);
          return;
        }
        if (!consentRes.ok) {
          const errJson = await consentRes.json().catch(() => ({}));
          throw new Error(errJson.message || 'Failed to load consent info');
        }
        
        const consentData = await consentRes.json();
        setClientInfo(consentData.client || {});
        setCurrentWebId(consentData.webId || null);

        const pickRes = await fetch(pickWebIdUrl, { 
          headers: { Accept: 'application/json' }, 
          credentials: 'include' 
        });
        if (pickRes.ok) {
          const pickData = await pickRes.json();
          const ids = pickData.webIds || [];
          setWebIds(ids);
          if (consentData.webId && ids.includes(consentData.webId)) {
            setSelectedWebId(consentData.webId);
          } else if (ids.length > 0) {
            setSelectedWebId(ids[0]);
          }
        }
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
        await fetch(controls.account.logout, { method: 'POST', credentials: 'include' });
      }
      window.location.href = '/.account/login/password/';
    } catch {
      window.location.href = '/.account/login/password/';
    }
  };

  const handleConsent = async (allow: boolean) => {
    try {
      setIsLoading(true);
      setError(null);

      if (!allow) {
        const res = await fetch(cancelUrl, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, 
          credentials: 'include',
          body: JSON.stringify({})
        });
        const json = await res.json();
        if (json.location) {
          window.location.href = json.location;
        }
        return;
      }

      if (selectedWebId && selectedWebId !== currentWebId) {
        const pickRes = await fetch(pickWebIdUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ remember: rememberClient })
      });
      const consentJson = await consentRes.json();
      if (!consentRes.ok) {
        throw new Error(consentJson.message || 'Consent failed');
      }

      if (consentJson.location) {
        window.location.href = consentJson.location;
      }
    } catch (err: any) {
      setError(err.message || 'Consent failed');
      setIsLoading(false);
    }
  };

  const displayWebIds = webIds.length > 0 ? webIds : (currentWebId ? [currentWebId] : []);

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
              <div className="text-center py-4">
                <p className="text-zinc-500 text-xs mb-3">You need to create a Pod first to get a WebID.</p>
                <button
                  onClick={() => {
                    persistReturnTo(window.location.href);
                    navigate('/.account/account/');
                  }}
                  className="px-4 py-2 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white text-xs rounded-lg"
                >
                  Create Pod
                </button>
              </div>
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
              disabled={isLoading}
              className="py-2.5 border border-zinc-200 rounded-xl text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 transition-colors"
            >
              Deny
            </button>
            <button 
              onClick={() => handleConsent(true)} 
              disabled={isLoading || displayWebIds.length === 0}
              className="py-2.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-xs disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Authorizing...' : 'Authorize'}
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
