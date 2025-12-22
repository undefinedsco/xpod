import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, User, HardDrive, Key, Plus, Trash2, Globe, Database, Shield } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function AccountPage() {
  const { controls, refetchControls } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [pods, setPods] = useState<{ id: string; name?: string }[]>([]);
  const [showCreatePod, setShowCreatePod] = useState(false);
  const [podName, setPodName] = useState('');
  const [showLinkWebId, setShowLinkWebId] = useState(false);
  const [linkWebIdUrl, setLinkWebIdUrl] = useState('');
  const [credentials, setCredentials] = useState<{ id: string; secret?: string }[]>([]);
  const [newCredential, setNewCredential] = useState<{ id: string; secret: string } | null>(null);

  const fetchData = async () => {
    try {
      if (controls?.account?.webId) {
        const res = await fetch(controls.account.webId, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const links = json.webIdLinks || {};
          setWebIds(Object.keys(links));
        }
      }
      if (controls?.account?.pod) {
        const res = await fetch(controls.account.pod, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const podObj = json.pods || {};
          setPods(Object.keys(podObj).map(id => ({ id })));
        }
      }
      if (controls?.account?.clientCredentials) {
        const res = await fetch(controls.account.clientCredentials, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const creds = json.clientCredentials || {};
          setCredentials(Object.entries(creds).map(([id]) => ({ id })));
        }
      }
    } catch (err) {
      console.error('Failed to fetch account data:', err);
    }
  };

  useEffect(() => {
    fetchData();
  }, [controls]);

  const handleLogout = async () => {
    if (!controls?.account?.logout) return;
    setIsLoading(true);
    try {
      const res = await fetch(controls.account.logout, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (res.ok) {
        await refetchControls();
        navigate('/.account/');
      }
    } catch {
      alert('Logout failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreatePod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controls?.account?.pod || !podName.trim()) return;
    setIsLoading(true);
    try {
      const res = await fetch(controls.account.pod, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: podName.trim() }),
      });
      if (res.ok) {
        setPodName('');
        setShowCreatePod(false);
        await fetchData();
      } else {
        const json = await res.json().catch(() => ({}));
        alert(json.message || 'Failed to create pod');
      }
    } catch {
      alert('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLinkWebId = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controls?.account?.webId || !linkWebIdUrl.trim()) return;
    setIsLoading(true);
    try {
      const res = await fetch(controls.account.webId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ webId: linkWebIdUrl.trim() }),
      });
      if (res.ok) {
        setLinkWebIdUrl('');
        setShowLinkWebId(false);
        await fetchData();
      } else {
        const json = await res.json().catch(() => ({}));
        alert(json.message || 'Failed to link WebID');
      }
    } catch {
      alert('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeletePod = async (podUrl: string) => {
    if (!confirm(`Delete pod ${podUrl}? This cannot be undone.`)) return;
    setIsLoading(true);
    try {
      const res = await fetch(podUrl, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        await fetchData();
      } else {
        alert('Failed to delete pod');
      }
    } catch {
      alert('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateCredential = async () => {
    if (!controls?.account?.clientCredentials) return;
    setIsLoading(true);
    try {
      const res = await fetch(controls.account.clientCredentials, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: `key-${Date.now()}` }),
      });
      if (res.ok) {
        const json = await res.json();
        setNewCredential({ id: json.id, secret: json.secret });
        await fetchData();
      } else {
        const json = await res.json().catch(() => ({}));
        alert(json.message || 'Failed to create credential');
      }
    } catch {
      alert('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteCredential = async (credId: string) => {
    if (!confirm('Delete this credential? This cannot be undone.')) return;
    setIsLoading(true);
    try {
      const res = await fetch(credId, { method: 'DELETE', headers: { Accept: 'application/json' }, credentials: 'include' });
      if (res.ok) {
        await fetchData();
      } else {
        alert('Failed to delete credential');
      }
    } catch {
      alert('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-violet-600/5 rounded-full blur-[120px] opacity-40" />
      </div>
      <header className="relative z-10 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center">
              <div className="w-4 h-4 border-2 border-white rounded opacity-80" />
            </div>
            <span className="font-semibold">Xpod</span>
          </div>
          <button onClick={handleLogout} disabled={isLoading} className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors">
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </header>
      <main className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-8">
        <h1 className="text-2xl font-bold">Account Dashboard</h1>

        {/* WebIDs Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><User className="w-4 h-4 text-violet-400" />Identity</h2>
            {controls?.account?.webId && (
              <button onClick={() => setShowLinkWebId(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />Link WebID
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">Your unique decentralized identifiers (WebIDs). This is your identity on the Solid network.</p>
          
          {showLinkWebId && (
            <form onSubmit={handleLinkWebId} className="mb-4 p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl">
              <label className="block text-xs text-zinc-400 mb-2">WebID URL</label>
              <div className="flex gap-2">
                <input type="url" value={linkWebIdUrl} onChange={(e) => setLinkWebIdUrl(e.target.value)} placeholder="https://example.com/profile/card#me" className="flex-1 px-3 py-2 bg-zinc-900/50 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none" required />
                <button type="submit" disabled={isLoading} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg disabled:opacity-50">{isLoading ? 'Linking...' : 'Link'}</button>
                <button type="button" onClick={() => setShowLinkWebId(false)} className="px-3 py-2 text-zinc-400 hover:text-white text-xs">Cancel</button>
              </div>
            </form>
          )}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl">
            {webIds.length === 0 ? (
              <p className="p-4 text-xs text-zinc-500">No WebIDs found.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/50">
                {webIds.map((id) => (
                  <li key={id} className="p-3 flex items-center gap-3">
                    <Globe className="w-4 h-4 text-zinc-500 shrink-0" />
                    <a href={id} target="_blank" rel="noopener" className="text-xs font-mono text-violet-400 hover:text-violet-300 truncate">{id}</a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Pods Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><HardDrive className="w-4 h-4 text-violet-400" />Storage</h2>
            {controls?.account?.pod && (
              <button onClick={() => setShowCreatePod(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />Add Pod
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">Your personal data stores (Pods). You own and control all data stored here.</p>
          
          {showCreatePod && (
            <form onSubmit={handleCreatePod} className="mb-4 p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl">
              <label className="block text-xs text-zinc-400 mb-2">Pod Name</label>
              <div className="flex gap-2">
                <input type="text" value={podName} onChange={(e) => setPodName(e.target.value)} placeholder="my-pod" className="flex-1 px-3 py-2 bg-zinc-900/50 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none" required />
                <button type="submit" disabled={isLoading} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg disabled:opacity-50">{isLoading ? 'Creating...' : 'Create'}</button>
                <button type="button" onClick={() => setShowCreatePod(false)} className="px-3 py-2 text-zinc-400 hover:text-white text-xs">Cancel</button>
              </div>
            </form>
          )}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl">
            {pods.length === 0 ? (
              <div className="p-4"><p className="text-xs text-zinc-500 mb-3">No Pods found. Create one to get started.</p></div>
            ) : (
              <ul className="divide-y divide-zinc-800/50">
                {pods.map((pod) => (
                  <li key={pod.id} className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <Database className="w-4 h-4 text-zinc-500 shrink-0" />
                      <a href={pod.id} target="_blank" rel="noopener" className="text-xs font-mono text-violet-400 hover:text-violet-300 truncate">{pod.id}</a>
                    </div>
                    <button onClick={() => handleDeletePod(pod.id)} className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors" title="Delete Pod">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* API Keys Section */}
        <section>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><Key className="w-4 h-4 text-violet-400" />Developer Access</h2>
            {controls?.account?.clientCredentials && (
              <button onClick={handleCreateCredential} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />New Key
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">API keys (Client Credentials) allow external applications and scripts to access your Pod programmatically.</p>
          
          {!controls?.account?.clientCredentials ? (
            <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
              <p className="text-xs text-zinc-500">Client credential endpoint not configured.</p>
            </div>
          ) : (
            <>
              {newCredential && (
                <div className="mb-4 p-4 bg-green-500/10 border border-green-500/30 rounded-xl">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-green-500/20 rounded-lg"><Key className="w-4 h-4 text-green-500" /></div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-green-400 mb-1">New Key Created</p>
                      <p className="text-xs text-zinc-400 mb-3">Please copy the secret now. It will not be shown again.</p>
                      <div className="space-y-2 text-xs font-mono bg-black/30 p-3 rounded-lg border border-white/5">
                        <p><span className="text-zinc-500 select-none">ID:     </span> <span className="text-zinc-300">{newCredential.id}</span></p>
                        <p><span className="text-zinc-500 select-none">Secret: </span> <span className="text-green-300">{newCredential.secret}</span></p>
                      </div>
                      <button onClick={() => setNewCredential(null)} className="mt-3 text-xs text-zinc-400 hover:text-white font-medium">I have copied it</button>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl">
                {credentials.length === 0 ? (
                  <p className="p-4 text-xs text-zinc-500">No API keys found.</p>
                ) : (
                  <ul className="divide-y divide-zinc-800/50">
                    {credentials.map((cred) => (
                      <li key={cred.id} className="p-3 flex items-center justify-between">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <Key className="w-4 h-4 text-zinc-500 shrink-0" />
                          <span className="text-xs font-mono text-zinc-400 truncate">{cred.id}</span>
                        </div>
                        <button onClick={() => handleDeleteCredential(cred.id)} className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors" title="Revoke Key">
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
          <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-3"><Shield className="w-4 h-4 text-violet-400" />Security</h2>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-medium mb-1">Password</h3>
              <p className="text-[10px] text-zinc-500">Update your account password</p>
            </div>
            <a href={controls?.password?.forgot || '/.account/login/password/forgot/'} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg transition-colors">
              Change Password
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
