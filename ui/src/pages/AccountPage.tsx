import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogOut, User, HardDrive, Key, Plus, Trash2, Globe, Database, Shield, Copy, Check, ChevronDown, Info, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function AccountPage() {
  const { controls, refetchControls, hasOidcPending } = useAuth();
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
  const [showCreateCredential, setShowCreateCredential] = useState(false);
  const [credentialWebId, setCredentialWebId] = useState('');
  const [credentialName, setCredentialName] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showWebIdDropdown, setShowWebIdDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const fetchData = async () => {
    try {
      if (controls?.account?.webId) {
        const res = await fetch(controls.account.webId, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const links = json.webIdLinks || {};
          setWebIds(Object.keys(links));
        } else {
          // No WebIDs yet is normal for new users
          setWebIds([]);
        }
      }
      if (controls?.account?.pod) {
        const res = await fetch(controls.account.pod, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const podObj = json.pods || {};
          setPods(Object.keys(podObj).map(id => ({ id })));
        } else {
          setPods([]);
        }
      }
      if (controls?.account?.clientCredentials) {
        const res = await fetch(controls.account.clientCredentials, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const creds = json.clientCredentials || {};
          setCredentials(Object.entries(creds).map(([id]) => ({ id })));
        } else {
          setCredentials([]);
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
        // Refresh controls to get updated endpoints (including new WebID)
        await refetchControls();
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

  const handleCreateCredential = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controls?.account?.clientCredentials || !credentialWebId || !credentialName.trim()) return;
    setIsLoading(true);
    try {
      const res = await fetch(controls.account.clientCredentials, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
        const json = await res.json().catch(() => ({}));
        alert(json.message || 'Failed to create credential');
      }
    } catch {
      alert('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  const openCreateCredential = () => {
    if (webIds.length === 0) {
      alert('Please create a Pod first to get a WebID');
      return;
    }
    setCredentialWebId(webIds[0]);
    setCredentialName('');
    setShowCreateCredential(true);
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
              <div className="p-4"><p className="text-xs text-zinc-500 mb-3">No Pods found. Create one to get started.</p></div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {pods.map((pod) => (
                  <li key={pod.id} className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <Database className="w-4 h-4 text-zinc-400 shrink-0" />
                      <a href={pod.id} target="_blank" rel="noopener" className="text-xs font-mono text-[#7C4DFF] hover:text-[#6B3FE8] truncate">{pod.id}</a>
                    </div>
                    <button onClick={() => handleDeletePod(pod.id)} className="p-2 text-zinc-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete Pod">
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
          <p className="text-[11px] text-zinc-500 mb-3">API keys (Client Credentials) allow external applications and scripts to access your Pod programmatically.</p>
          
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
                      <p className="text-sm font-medium text-emerald-700 mb-1">New Key Created</p>
                      <p className="text-xs text-zinc-500 mb-3">Please copy the secret now. It will not be shown again.</p>
                      <div className="space-y-3 text-xs font-mono bg-white p-3 rounded-lg border border-zinc-200">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-zinc-400 select-none">ID</span>
                            <p className="text-zinc-700 truncate">{newCredential.id}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(newCredential.id, 'id')}
                            className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors shrink-0"
                            title="Copy ID"
                          >
                            {copiedField === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-zinc-400 select-none">Secret</span>
                            <p className="text-emerald-600 break-all">{newCredential.secret}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(newCredential.secret, 'secret')}
                            className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors shrink-0"
                            title="Copy Secret"
                          >
                            {copiedField === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                      <button onClick={() => setNewCredential(null)} className="mt-3 text-xs text-zinc-500 hover:text-zinc-900 font-medium">I have copied it</button>
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
                        <button onClick={() => handleDeleteCredential(cred.id)} className="p-2 text-zinc-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Revoke Key">
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
