import { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Lock, Mail, ArrowRight, Loader2, Clock, Layers, Shield, Check } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { persistReturnTo, consumeReturnTo, getReturnToFromLocation } from '../utils/returnTo';

interface WelcomePageProps {
  initialIsRegister?: boolean;
}

export function WelcomePage({ initialIsRegister = false }: WelcomePageProps) {
  const { controls, idpIndex, isLoggedIn, authenticating } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(initialIsRegister);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);

  const passwordsMatch = password.length > 0 && confirmPassword.length > 0 && password === confirmPassword;

  useEffect(() => {
    const returnTo = getReturnToFromLocation();
    if (returnTo) persistReturnTo(returnTo);
  }, []);

  // If already logged in, redirect to dashboard
  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }

  const features = [
    { icon: Clock, title: 'Your AI Never Stops', desc: 'Runs 24/7, even when you\'re not talking to it' },
    { icon: Layers, title: 'One Place for Your Whole Life', desc: 'All your messages together in one place' },
    { icon: Shield, title: 'One Secretary, A Thousand Agents', desc: 'Full power, full privacy' },
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
        // Step 1: Create account
        let res = await fetch(controls?.account?.create || '/.account/account/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed to create account');

        // Step 2: Fetch controls to get password.create endpoint
        res = await fetch(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' });
        const data = await res.json();
        const addPasswordUrl = data.controls?.password?.create;
        if (!addPasswordUrl) throw new Error('Password endpoint not found');

        // Step 3: Set password
        res = await fetch(addPasswordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed to set password');

        // Step 4: Auto-login after registration
        const loginUrl = data.controls?.password?.login || controls?.password?.login || '/.account/login/password/';
        res = await fetch(loginUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Auto-login failed');

        // Registration complete, redirect to account page to create Pod
        window.location.href = '/.account/account/';
      } else {
        const res = await fetch(controls?.password?.login || '/.account/login/password/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        const json = await res.json().catch(() => ({}));
        console.log('[Login] Response status:', res.status);
        console.log('[Login] Response json:', json);
        console.log('[Login] Location header:', res.headers.get('Location'));
        
        if (res.ok) {
          // Check if there's an OIDC flow waiting (CSS returns location to consent)
          const headerLocation = res.headers.get('Location');
          console.log('[Login] json.location:', json.location);
          console.log('[Login] headerLocation:', headerLocation);
          
          if (json.location) {
            console.log('[Login] Redirecting to json.location:', json.location);
            window.location.href = json.location;
            return;
          }
          if (headerLocation) {
            console.log('[Login] Redirecting to headerLocation:', headerLocation);
            window.location.href = headerLocation;
            return;
          }
          
          // No OIDC redirect, check for returnTo or check if OIDC consent is pending
          const returnTo = consumeReturnTo();
          console.log('[Login] returnTo:', returnTo);
          if (returnTo) {
            console.log('[Login] Redirecting to returnTo:', returnTo);
            window.location.href = returnTo;
            return;
          }
          
          // Check if there's an OIDC session waiting for consent
          console.log('[Login] Checking for OIDC consent...');
          try {
            const consentCheck = await fetch('/.account/oidc/consent/', {
              headers: { Accept: 'application/json' },
              credentials: 'include',
            });
            console.log('[Login] Consent check status:', consentCheck.status);
            if (consentCheck.ok) {
              // OIDC flow is waiting, go to consent
              console.log('[Login] OIDC flow waiting, redirecting to consent');
              window.location.href = '/.account/oidc/consent/';
              return;
            }
          } catch (e) {
            console.log('[Login] Consent check error:', e);
            // No OIDC flow, continue to dashboard
          }
          
          console.log('[Login] No redirect found, going to dashboard');
          window.location.href = '/.account/account/';
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
    setPassword('');
    setConfirmPassword('');
  };

  // OIDC Cancel handler
  const handleCancel = async () => {
    if (!controls?.oidc?.cancel) return;
    setIsCancelling(true);
    try {
      const res = await fetch(controls.oidc.cancel, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
      });
      const json = await res.json();
      if (json.location) {
        window.location.href = json.location;
      }
    } catch {
      alert('Failed to cancel');
      setIsCancelling(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans flex items-center justify-center p-4 lg:p-8">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[800px] h-[600px] bg-[#7C4DFF]/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[400px] bg-[#7C4DFF]/3 rounded-full blur-[100px]" />
      </div>

      <div className="w-full max-w-6xl grid lg:grid-cols-2 gap-8 lg:gap-16 items-center relative z-10">
        {/* Left - Brand */}
        <div className="hidden lg:block px-8">
          <div className="max-w-md ml-auto">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-12 h-12 bg-[#7C4DFF] rounded-xl shadow-lg shadow-[#7C4DFF]/20 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white rounded opacity-90" />
              </div>
              <div>
                <div className="text-2xl font-bold leading-tight">Xpod</div>
                <div className="text-[10px] text-zinc-500 leading-tight">Personal Messages Platform</div>
              </div>
            </div>

            <h1 className="text-2xl xl:text-3xl font-bold leading-tight mb-4">
              Simplify Life with <span className="text-[#7C4DFF]">Your AI Secretary</span>
            </h1>
            <p className="text-zinc-500 text-sm leading-relaxed mb-10">
              An AI that never stops, knows your whole life, works for you—while guarding your privacy.
            </p>

            <div className="space-y-4">
              <div className="space-y-3">
                {features.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-3">
                    <div className="w-8 h-8 bg-white border border-zinc-200 rounded-lg flex items-center justify-center shrink-0 shadow-sm">
                      <Icon className="w-4 h-4 text-[#7C4DFF]" />
                    </div>
                    <div>
                      <h3 className="text-xs font-medium text-zinc-900">{title}</h3>
                      <p className="text-[10px] text-zinc-500">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="mt-12">
              <p className="text-[10px] text-zinc-400">
                Powered by <a href="https://solidproject.org" target="_blank" rel="noopener" className="text-[#7C4DFF] hover:text-[#6B3FE8]">Solid Protocol</a>
              </p>
            </div>
          </div>
        </div>

        {/* Right - Auth Form */}
        <div className="w-full max-w-sm mx-auto lg:mx-0">
          <div className="bg-white border border-zinc-200 rounded-3xl p-6 lg:p-8 shadow-xl shadow-zinc-200/50">
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-[#7C4DFF] rounded-xl flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white rounded opacity-90" />
              </div>
              <div>
                <div className="text-xl font-bold leading-tight">Xpod</div>
                <div className="text-[10px] text-zinc-500 leading-tight">Personal Messages Platform</div>
              </div>
            </div>

            <div className="mb-6">
              <h2 className="text-xl font-bold">{isRegister ? 'Create account' : 'Welcome back'}</h2>
              <p className="text-zinc-500 text-xs mt-1">
                {isRegister ? 'Create your Xpod account to get started.' : 'Sign in to continue your identity workspace.'}
              </p>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-3">
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    name="email"
                    type="email"
                    required
                    className="block w-full pl-10 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm placeholder:text-zinc-400 focus:border-[#7C4DFF] focus:outline-none transition-colors"
                    placeholder="Email"
                  />
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    name="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="block w-full pl-10 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm placeholder:text-zinc-400 focus:border-[#7C4DFF] focus:outline-none transition-colors"
                    placeholder="Password"
                  />
                </div>
                {isRegister && (
                  <div className="relative">
                    {passwordsMatch ? (
                      <Check className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-emerald-500" />
                    ) : (
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                    )}
                    <input
                      name="confirmPassword"
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={clsx(
                        "block w-full pl-10 pr-4 py-2.5 bg-zinc-50 border rounded-xl text-sm placeholder:text-zinc-400 focus:outline-none transition-colors",
                        passwordsMatch ? "border-emerald-300 focus:border-emerald-500" : "border-zinc-200 focus:border-[#7C4DFF]"
                      )}
                      placeholder="Confirm password"
                    />
                  </div>
                )}
              </div>

              {!isRegister && (
                <div className="flex justify-end">
                  <button type="button" onClick={() => navigate('/.account/login/password/forgot/')} className="text-[11px] text-[#7C4DFF] hover:text-[#6B3FE8]">
                    Forgot password?
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading || isCancelling}
                className="w-full py-3 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    {isRegister ? 'Sign up' : 'Sign in'}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              {/* OIDC Cancel button - only show during OIDC authentication flow */}
              {authenticating && !isRegister && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isCancelling || isLoading}
                  className="w-full py-3 border border-zinc-200 hover:bg-zinc-100 text-zinc-600 rounded-xl text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
                >
                  {isCancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Cancel'}
                </button>
              )}
            </form>

            <div className="mt-6 pt-6 border-t border-zinc-100 text-center">
              <p className="text-[11px] text-zinc-500">
                {isRegister ? 'Already have an account? ' : "Don't have an account? "}
                <button onClick={toggleMode} className="text-[#7C4DFF] font-medium hover:text-[#6B3FE8]">
                  {isRegister ? 'Sign in' : 'Sign up'}
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
