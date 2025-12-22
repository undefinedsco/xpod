import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, AlertCircle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';
import { persistReturnTo } from '../utils/returnTo';

export function ConsentPage() {
  const { idpIndex, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [clientInfo, setClientInfo] = useState<any>(null);
  const [currentWebId, setCurrentWebId] = useState<string | null>(null);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [selectedWebId, setSelectedWebId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);

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
        body: JSON.stringify({ remember: true })
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
        <div className="mb-4 bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 text-zinc-300 text-[11px] space-y-3">
          <p>Sign in to approve this request and choose which WebID to share.</p>
          <button
            onClick={() => {
              persistReturnTo(window.location.href);
              navigate('/.account/login/password/');
            }}
            className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs font-medium"
          >
            Go to Sign in
          </button>
        </div>
      )}
      
      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-[11px]">
          <AlertCircle className="w-4 h-4 inline mr-2" />{error}
        </div>
      )}
      
      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-6 h-6 animate-spin text-violet-500" />
        </div>
      ) : (
        <div className="space-y-4">
          {clientInfo?.client_uri && (
            <div className="text-center text-[11px] text-zinc-500">
              <a href={clientInfo.client_uri} target="_blank" rel="noopener" className="text-violet-400 hover:text-violet-300">
                {clientInfo.client_uri}
              </a>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                Sign in as
              </label>
              {displayWebIds.length > 0 && (
                <div className="text-[10px] text-zinc-500">
                  Provider: <span className="text-zinc-400">{parseWebIdInfo(displayWebIds[0]).provider}</span>
                </div>
              )}
            </div>
            {displayWebIds.length === 0 ? (
              <p className="text-red-400 text-[11px]">No identities found. Please create a WebID first.</p>
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
                          ? "border-violet-500/50 bg-violet-500/10" 
                          : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                      )}
                    >
                      <input 
                        type="radio" 
                        name="webId" 
                        value={id} 
                        checked={selectedWebId === id} 
                        onChange={e => setSelectedWebId(e.target.value)} 
                        className="text-violet-600" 
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-zinc-200 truncate" title={info.full}>
                          {info.podId}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          copyWebId(id);
                        }}
                        className="px-2 py-1 text-[10px] rounded-lg border border-zinc-700 text-zinc-300 hover:text-white hover:border-violet-500/50 shrink-0"
                      >
                        {copyState === id ? 'Copied' : 'Copy'}
                      </button>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <button 
              onClick={() => handleConsent(false)} 
              disabled={isLoading}
              className="py-2.5 border border-zinc-800 rounded-xl text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
            >
              Deny
            </button>
            <button 
              onClick={() => handleConsent(true)} 
              disabled={isLoading || displayWebIds.length === 0}
              className="py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Authorizing...' : 'Authorize'}
            </button>
          </div>
        </div>
      )}
    </CardWrapper>
  );
}
