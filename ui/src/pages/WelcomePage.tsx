import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Mail, ArrowRight, Loader2, Check, Globe, Database, Users, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { persistReturnTo, consumeReturnTo, getReturnToFromLocation } from '../utils/returnTo';

interface WelcomePageProps {
  initialIsRegister?: boolean;
}

export function WelcomePage({ initialIsRegister = false }: WelcomePageProps) {
  const { controls, idpIndex } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(initialIsRegister);
  const [featureTab, setFeatureTab] = useState<'user' | 'developer'>('user');

  useEffect(() => {
    const returnTo = getReturnToFromLocation();
    if (returnTo) persistReturnTo(returnTo);
  }, []);

  const userFeatures = [
    { icon: Globe, title: 'Your Data Space', desc: 'Keep your data in one place you control' },
    { icon: Database, title: 'Permissioned Sharing', desc: 'Grant and revoke access any time' },
  ];
  const developerFeatures = [
    { icon: Users, title: 'Solid All-in-One', desc: 'File system, database, notifications, and identity' },
    { icon: Zap, title: 'Deploy & Connect', desc: 'Cloud/edge routing with built-in tunneling' },
    { icon: Database, title: 'Operate at Scale', desc: 'Accounts, pods, and usage stored in databases' },
  ];

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    const form = new FormData(e.currentTarget);
    const email = form.get('email') as string;
    const password = form.get('password') as string;

    try {
      if (isRegister) {
        const confirm = form.get('confirmPassword') as string;
        if (password !== confirm) {
          alert('Passwords do not match');
          setIsLoading(false);
          return;
        }
        let res = await fetch(controls?.account?.create || '/.account/account/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed to create account');

        res = await fetch(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' });
        const data = await res.json();
        const addPasswordUrl = data.controls?.password?.create;
        if (!addPasswordUrl) throw new Error('Password endpoint not found');

        res = await fetch(addPasswordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed to set password');

        const returnTo = consumeReturnTo();
        window.location.href = returnTo || '/.account/account/';
      } else {
        const res = await fetch(controls?.password?.login || '/.account/login/password/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          const returnTo = consumeReturnTo();
          const headerLocation = res.headers.get('Location');
          window.location.href = json.location || headerLocation || returnTo || '/.account/account/';
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

  const toggleMode = () => setIsRegister(!isRegister);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center p-4 lg:p-8">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[800px] h-[600px] bg-violet-600/8 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[400px] bg-indigo-600/5 rounded-full blur-[100px]" />
      </div>

      <div className="w-full max-w-6xl grid lg:grid-cols-2 gap-8 lg:gap-16 items-center relative z-10">
        {/* Left - Brand */}
        <div className="hidden lg:block px-8">
          <div className="max-w-md ml-auto">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl shadow-lg shadow-violet-500/30 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white rounded opacity-90" />
              </div>
              <span className="text-2xl font-bold">Xpod</span>
            </div>

            <h1 className="text-3xl xl:text-4xl font-bold leading-tight mb-4">
              Xpod Identity
              <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent"> Control</span>
            </h1>
            <p className="text-zinc-400 text-sm leading-relaxed mb-10">
              Run authentication, pod access, and app authorization in one secure control plane.
            </p>

            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 p-1">
                <button
                  type="button"
                  onClick={() => setFeatureTab('user')}
                  className={clsx(
                    'px-3 py-1.5 text-[10px] font-medium rounded-full transition-colors',
                    featureTab === 'user' ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-white'
                  )}
                >
                  For Users
                </button>
                <button
                  type="button"
                  onClick={() => setFeatureTab('developer')}
                  className={clsx(
                    'px-3 py-1.5 text-[10px] font-medium rounded-full transition-colors',
                    featureTab === 'developer' ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-white'
                  )}
                >
                  For Developers
                </button>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-violet-400 mb-2">
                  {featureTab === 'user' ? 'For Users' : 'For Developers'}
                </p>
                <div className="grid grid-cols-2 gap-4">
                  {(featureTab === 'user' ? userFeatures : developerFeatures).map(({ icon: Icon, title, desc }) => (
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
              </div>
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
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white rounded opacity-90" />
              </div>
              <span className="text-xl font-bold">Xpod</span>
            </div>

            <div className="mb-6">
              <h2 className="text-xl font-bold">{isRegister ? 'Create your Pod' : 'Welcome back'}</h2>
              <p className="text-zinc-500 text-xs mt-1">
                {isRegister ? 'Create your Xpod account to get started.' : 'Sign in to continue your identity workspace.'}
              </p>
            </div>

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
