import { useState, useEffect, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Lock, Mail, ArrowRight, Loader2, AlertCircle, Check, Shield, ArrowLeft, Globe, Database, Users, Zap, LogOut, User, HardDrive, Key, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';

// === Types ===
interface Controls {
  password?: { login?: string; create?: string; forgot?: string; reset?: string };
  account?: { create?: string; logout?: string; webId?: string; pod?: string; clientCredentials?: string };
  html?: { password?: { login?: string; register?: string; forgot?: string }; account?: { account?: string } };
  oidc?: { webId?: string; consent?: string; cancel?: string };
  main?: { logins?: string; index?: string };
}

interface AuthContextType {
  controls: Controls | null;
  isInitializing: boolean;
  initError: string | null;
  idpIndex: string;
  authenticating: boolean;
  isLoggedIn: boolean;
  refetchControls: () => Promise<void>;
}

// === Context ===
const AuthContext = createContext<AuthContextType | null>(null);

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// === Auth Provider ===
function AuthProvider({ children }: { children: React.ReactNode }) {
  const initialData = (window as any).__XPOD__ || (window as any).__INITIAL_DATA__ || { idpIndex: '/.account/', authenticating: false };
  const [controls, setControls] = useState<Controls | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const idpIndex = typeof initialData.idpIndex === 'string' ? initialData.idpIndex : '/.account/';
  
  // User is logged in if controls has account.logout
  const isLoggedIn = Boolean(controls?.account?.logout);

  const fetchControls = async () => {
    try {
      const res = await fetch(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setControls(json.controls || {});
      } else {
        setInitError('Failed to load configuration');
      }
    } catch {
      setInitError('Network error');
    }
  };

  useEffect(() => {
    (async () => {
      await fetchControls();
      setIsInitializing(false);
    })();
  }, [idpIndex]);

  const refetchControls = async () => {
    await fetchControls();
  };

  return (
    <AuthContext.Provider value={{ controls, isInitializing, initError, idpIndex, authenticating: initialData.authenticating, isLoggedIn, refetchControls }}>
      {children}
    </AuthContext.Provider>
  );
}

// === UI Components ===
function CardWrapper({ children, title, subtitle, icon: Icon, showBack, onBack }: {
  children: React.ReactNode; title: string; subtitle?: string; icon?: any; showBack?: boolean; onBack?: () => void;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-violet-600/5 rounded-full blur-[120px] opacity-40" />
      </div>
      <div className="w-full max-w-[360px] bg-zinc-900/40 backdrop-blur-2xl border border-zinc-800/50 rounded-3xl shadow-2xl p-6 relative z-10">
        <div className="flex flex-col items-center mb-6">
          <div className="flex w-full items-center justify-between mb-4">
            {showBack ? (
              <button onClick={onBack} className="p-2 -ml-2 rounded-full hover:bg-zinc-800/50 text-zinc-400 hover:text-white transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </button>
            ) : <div className="w-8" />}
            <div className="w-10 h-10 bg-violet-600 rounded-xl shadow-lg shadow-violet-500/20 flex items-center justify-center">
              {Icon ? <Icon className="w-5 h-5 text-white" /> : <div className="w-5 h-5 border-2 border-white rounded opacity-80" />}
            </div>
            <div className="w-8" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-center">{title}</h2>
          {subtitle && <p className="mt-1 text-zinc-400 text-[11px] text-center leading-relaxed">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100 items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-violet-500" />
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <CardWrapper title="Error" subtitle={message} icon={AlertCircle}>
      <button onClick={() => window.location.reload()} className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-xs font-medium transition-colors">
        Retry
      </button>
    </CardWrapper>
  );
}

// === Pages ===

function ForgotPasswordPage() {
  const { controls } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    const email = new FormData(e.currentTarget).get('email') as string;

    try {
      await fetch(controls?.password?.forgot || '/.account/login/password/forgot/', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'include', body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      alert('Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <CardWrapper title="Reset Password" subtitle="We will send a reset link to your email." icon={Mail} showBack onBack={() => navigate('../')}>
      {sent ? (
        <div className="space-y-4">
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
            <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3"><Check className="w-5 h-5 text-green-500" /></div>
            <p className="text-xs text-zinc-300">If that email exists, we've sent a reset link.</p>
          </div>
          <button onClick={() => navigate('../')} className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm font-medium">Back to Sign in</button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
            <input name="email" type="email" required className="block w-full pl-10 pr-4 py-2.5 bg-zinc-900/50 border border-zinc-800 rounded-xl text-sm" placeholder="Email address" />
          </div>
          <button type="submit" disabled={isLoading} className="w-full py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Send Reset Link <ArrowRight className="h-4 w-4" /></>}
          </button>
        </form>
      )}
    </CardWrapper>
  );
}

function ConsentPage() {
  const { controls } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [clientInfo, setClientInfo] = useState<any>(null);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [selectedWebId, setSelectedWebId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (controls?.oidc?.webId) {
          const res = await fetch(controls.oidc.webId, { headers: { Accept: 'application/json' }, credentials: 'include' });
          const json = await res.json();
          // webIdLinks is an object where keys are webIds
          const links = json.webIdLinks || {};
          const ids = Object.keys(links);
          setWebIds(ids);
          if (ids.length > 0) setSelectedWebId(ids[0]);
        }
        if (controls?.oidc?.consent) {
          const res = await fetch(controls.oidc.consent, { headers: { Accept: 'application/json' }, credentials: 'include' });
          setClientInfo(await res.json());
        }
      } catch {
        setError('Failed to load consent info');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [controls]);

  const handleConsent = async (allow: boolean) => {
    try {
      setIsLoading(true);
      if (!allow) {
        const res = await fetch(controls?.oidc?.cancel!, { method: 'POST', headers: { Accept: 'application/json' }, credentials: 'include' });
        window.location.href = (await res.json()).location;
        return;
      }
      let res = await fetch(controls?.oidc?.webId!, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'include', body: JSON.stringify({ webId: selectedWebId }) });
      let json = await res.json();
      if (!res.ok) throw new Error(json.message);
      await fetch(json.location, { credentials: 'include' });
      res = await fetch(controls?.oidc?.consent!, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'include', body: JSON.stringify({ remember: true }) });
      json = await res.json();
      if (!res.ok) throw new Error(json.message);
      window.location.href = json.location;
    } catch (err: any) {
      setError(err.message || 'Consent failed');
      setIsLoading(false);
    }
  };

  return (
    <CardWrapper title="Authorize" subtitle={`${clientInfo?.client_name || 'App'} requests access.`} icon={Shield}>
      {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-[11px]"><AlertCircle className="w-4 h-4 inline mr-2" />{error}</div>}
      {isLoading ? <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-violet-500" /></div> : (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Identity</label>
            {webIds.length === 0 ? <p className="text-red-400 text-[11px]">No identities found.</p> : (
              <div className="space-y-1">
                {webIds.map(id => (
                  <label key={id} className={clsx("flex items-center p-3 rounded-xl border cursor-pointer", selectedWebId === id ? "border-violet-500/50 bg-violet-500/10" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700")}>
                    <input type="radio" name="webId" value={id} checked={selectedWebId === id} onChange={e => setSelectedWebId(e.target.value)} className="text-violet-600" />
                    <span className="ml-3 text-[11px] font-mono text-zinc-300 truncate">{id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => handleConsent(false)} className="py-2.5 border border-zinc-800 rounded-xl text-xs text-zinc-400 hover:bg-zinc-800">Deny</button>
            <button onClick={() => handleConsent(true)} disabled={webIds.length === 0} className="py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs disabled:opacity-50">Authorize</button>
          </div>
        </div>
      )}
    </CardWrapper>
  );
}

function LoginSelectPage() {
  const { controls } = useAuth();
  const [logins, setLogins] = useState<[string, string][]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        if (controls?.main?.logins) {
          const res = await fetch(controls.main.logins, { headers: { Accept: 'application/json' }, credentials: 'include' });
          const json = await res.json();
          const entries = Object.entries(json.logins || {}) as [string, string][];
          if (entries.length === 1) { window.location.href = entries[0][1]; return; }
          setLogins(entries);
        }
      } catch {
        // Fallback to password login
        window.location.href = controls?.html?.password?.login || '/.account/login/password/';
      } finally {
        setIsLoading(false);
      }
    })();
  }, [controls]);

  if (isLoading) return <LoadingScreen />;

  return (
    <CardWrapper title="Select Login Method">
      <div className="space-y-2">
        {logins.map(([name, url]) => (
          <a key={name} href={url} className="block w-full py-3 px-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-center text-white text-sm font-medium">{name}</a>
        ))}
      </div>
    </CardWrapper>
  );
}

function WelcomePage({ initialIsRegister = false }: { initialIsRegister?: boolean }) {
  const { controls, idpIndex } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(initialIsRegister);

  const features = [
    { icon: Globe, title: 'Decentralized Identity', desc: 'Own your data with WebID' },
    { icon: Database, title: 'Personal Data Pod', desc: 'Store data in your own space' },
    { icon: Users, title: 'Interoperable', desc: 'Works with any Solid app' },
    { icon: Zap, title: 'Fast & Secure', desc: 'Built on modern standards' },
  ];

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    const form = new FormData(e.currentTarget);
    const email = form.get('email') as string;
    const password = form.get('password') as string;

    try {
      if (isRegister) {
        // Registration flow
        const confirm = form.get('confirmPassword') as string;
        if (password !== confirm) {
          alert('Passwords do not match');
          setIsLoading(false);
          return;
        }
        // Step 1: Create account
        let res = await fetch(controls?.account?.create || '/.account/account/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed to create account');

        // Step 2: Get password create URL
        res = await fetch(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' });
        const data = await res.json();
        const addPasswordUrl = data.controls?.password?.create;
        if (!addPasswordUrl) throw new Error('Password endpoint not found');

        // Step 3: Add password
        res = await fetch(addPasswordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed to set password');

        // Success - redirect to account
        window.location.href = '/.account/account/';
      } else {
        // Login flow
        const res = await fetch(controls?.password?.login || '/.account/login/password/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        const json = await res.json();
        if (res.ok) {
          window.location.href = json.location || '/.account/account/';
        } else {
          alert(json.message || 'Login failed');
        }
      }
    } catch (err: any) {
      alert(err.message || 'Operation failed');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegister(!isRegister);
    // Optional: update URL if needed, but keeping it simple for single-page feel
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center p-4 lg:p-8">
      {/* Background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[800px] h-[600px] bg-violet-600/8 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[400px] bg-indigo-600/5 rounded-full blur-[100px]" />
      </div>

      <div className="w-full max-w-6xl grid lg:grid-cols-2 gap-8 lg:gap-16 items-center relative z-10">
        {/* Left - Brand */}
        <div className="hidden lg:block px-8">
          <div className="max-w-md ml-auto">
            {/* Logo */}
            <div className="flex items-center gap-3 mb-8">
              <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl shadow-lg shadow-violet-500/30 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white rounded opacity-90" />
              </div>
              <span className="text-2xl font-bold">Xpod</span>
            </div>

            {/* Tagline */}
            <h1 className="text-3xl xl:text-4xl font-bold leading-tight mb-4">
              Your Personal
              <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent"> Data Pod</span>
            </h1>
            <p className="text-zinc-400 text-sm leading-relaxed mb-10">
              Take control of your digital identity. Store your data securely and share it on your terms with the power of Solid Protocol.
            </p>

            {/* Features */}
            <div className="grid grid-cols-2 gap-4">
              {features.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex gap-3">
                  <div className="w-8 h-8 bg-zinc-800/80 rounded-lg flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-xs font-medium text-white">{title}</h3>
                    <p className="text-[10px] text-zinc-500">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
            
            <div className="mt-12">
              <p className="text-[10px] text-zinc-600">
                Powered by <a href="https://solidproject.org" target="_blank" rel="noopener" className="text-violet-500 hover:text-violet-400">Solid Protocol</a>
              </p>
            </div>
          </div>
        </div>

        {/* Right - Auth Form */}
        <div className="w-full max-w-sm mx-auto lg:mx-0">
          <div className="bg-zinc-900/30 backdrop-blur-sm border border-zinc-800/50 rounded-3xl p-6 lg:p-8 shadow-xl">
            {/* Mobile Logo */}
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white rounded opacity-90" />
              </div>
              <span className="text-xl font-bold">Xpod</span>
            </div>

            {/* Form Header */}
            <div className="mb-6">
              <h2 className="text-xl font-bold">{isRegister ? 'Create your Pod' : 'Welcome back'}</h2>
              <p className="text-zinc-500 text-xs mt-1">
                {isRegister ? 'Start your journey with Xpod.' : 'Sign in to access your Pod.'}
              </p>
            </div>

            {/* Form */}
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-3">
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                  <input
                    name="email"
                    type="email"
                    required
                    className="block w-full pl-10 pr-4 py-2.5 bg-zinc-900/50 border border-zinc-800 rounded-xl text-sm placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none transition-colors"
                    placeholder="Email"
                  />
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                  <input
                    name="password"
                    type="password"
                    required
                    className="block w-full pl-10 pr-4 py-2.5 bg-zinc-900/50 border border-zinc-800 rounded-xl text-sm placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none transition-colors"
                    placeholder="Password"
                  />
                </div>
                {isRegister && (
                  <div className="relative">
                    <Check className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                    <input
                      name="confirmPassword"
                      type="password"
                      required
                      className="block w-full pl-10 pr-4 py-2.5 bg-zinc-900/50 border border-zinc-800 rounded-xl text-sm placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none transition-colors"
                      placeholder="Confirm password"
                    />
                  </div>
                )}
              </div>

              {!isRegister && (
                <div className="flex justify-end">
                  <button type="button" onClick={() => navigate('/.account/login/password/forgot/')} className="text-[11px] text-violet-500 hover:text-violet-400">
                    Forgot password?
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    {isRegister ? 'Create Pod' : 'Sign in'}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>

            {/* Toggle */}
            <div className="mt-6 pt-6 border-t border-zinc-800/50 text-center">
              <p className="text-[11px] text-zinc-500">
                {isRegister ? 'Already have an account? ' : "Don't have an account? "}
                <button onClick={toggleMode} className="text-violet-500 font-medium hover:text-violet-400">
                  {isRegister ? 'Sign in' : 'Create Pod'}
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// === Account Page (logged-in users) ===
function AccountPage() {
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
      const res = await fetch(podUrl, {
        method: 'DELETE',
        credentials: 'include',
      });
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
      const res = await fetch(credId, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
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
                <Plus className="w-3.5 h-3.5" />
                Link WebID
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">Your unique decentralized identifiers (WebIDs). This is your identity on the Solid network.</p>
          
          {showLinkWebId && (
            <form onSubmit={handleLinkWebId} className="mb-4 p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl">
              <label className="block text-xs text-zinc-400 mb-2">WebID URL</label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={linkWebIdUrl}
                  onChange={(e) => setLinkWebIdUrl(e.target.value)}
                  placeholder="https://example.com/profile/card#me"
                  className="flex-1 px-3 py-2 bg-zinc-900/50 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
                  required
                />
                <button type="submit" disabled={isLoading} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg disabled:opacity-50">
                  {isLoading ? 'Linking...' : 'Link'}
                </button>
                <button type="button" onClick={() => setShowLinkWebId(false)} className="px-3 py-2 text-zinc-400 hover:text-white text-xs">
                  Cancel
                </button>
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
                <Plus className="w-3.5 h-3.5" />
                Add Pod
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-3">Your personal data stores (Pods). You own and control all data stored here.</p>
          
          {showCreatePod && (
            <form onSubmit={handleCreatePod} className="mb-4 p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl">
              <label className="block text-xs text-zinc-400 mb-2">Pod Name</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={podName}
                  onChange={(e) => setPodName(e.target.value)}
                  placeholder="my-pod"
                  className="flex-1 px-3 py-2 bg-zinc-900/50 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
                  required
                />
                <button type="submit" disabled={isLoading} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs rounded-lg disabled:opacity-50">
                  {isLoading ? 'Creating...' : 'Create'}
                </button>
                <button type="button" onClick={() => setShowCreatePod(false)} className="px-3 py-2 text-zinc-400 hover:text-white text-xs">
                  Cancel
                </button>
              </div>
            </form>
          )}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl">
            {pods.length === 0 ? (
              <div className="p-4">
                <p className="text-xs text-zinc-500 mb-3">No Pods found. Create one to get started.</p>
              </div>
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
                <Plus className="w-3.5 h-3.5" />
                New Key
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
            <a 
              href={controls?.password?.forgot || '/.account/login/password/forgot/'} 
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg transition-colors"
            >
              Change Password
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}

// === Index Page (decides between Welcome and Account) ===
function IndexPage() {
  const { isLoggedIn } = useAuth();
  // If logged in at index, redirect to account page.
  // If not logged in, render WelcomePage directly (no redirect)
  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }
  return <WelcomePage />;
}

// Protected route wrapper - redirects to login if not authenticated
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoggedIn } = useAuth();
  if (!isLoggedIn) {
    return <Navigate to="/.account/login/password/" replace />;
  }
  return <>{children}</>;
}

// === Main App ===
function AppRoutes() {
  const { isInitializing, initError } = useAuth();
  
  if (isInitializing) return <LoadingScreen />;
  if (initError) return <ErrorScreen message={initError} />;

  return (
    <Routes>
      <Route path="/.account/" element={<IndexPage />} />
      <Route path="/.account/account/" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
      <Route path="/.account/login/" element={<LoginSelectPage />} />
      <Route path="/.account/login/password/" element={<WelcomePage initialIsRegister={false} />} />
      <Route path="/.account/login/password/register/" element={<WelcomePage initialIsRegister={true} />} />
      <Route path="/.account/login/password/forgot/" element={<ForgotPasswordPage />} />
      <Route path="/.account/oidc/consent/" element={<ConsentPage />} />
      {/* Fallback - redirect unknown paths to index */}
      <Route path="*" element={<Navigate to="/.account/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}