import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Mail, ArrowRight, Loader2, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';

export function ForgotPasswordPage() {
  const { controls, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);

  // If already logged in, redirect to dashboard
  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    const email = new FormData(e.currentTarget).get('email') as string;

    try {
      await fetch(controls?.password?.forgot || '/.account/login/password/forgot/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      alert('Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <CardWrapper title="Reset Password" subtitle="We will send a reset link to your email." icon={Mail} showBack onBack={() => navigate('/.account/login/password/')}>
      {sent ? (
        <div className="space-y-4">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
            <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Check className="w-5 h-5 text-emerald-600" />
            </div>
            <p className="text-xs text-zinc-600">If that email exists, we've sent a reset link.</p>
            <p className="text-[10px] text-zinc-500 mt-2">Check your spam folder if you don't see it.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => navigate('/.account/login/password/')} className="flex-1 py-3 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-sm font-medium">
              Sign in
            </button>
            <button onClick={() => setSent(false)} className="flex-1 py-3 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 rounded-xl text-sm font-medium">
              Resend
            </button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input name="email" type="email" required className="block w-full pl-10 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm placeholder:text-zinc-400 focus:border-[#7C4DFF] focus:outline-none" placeholder="Email address" />
          </div>
          <button type="submit" disabled={isLoading} className="w-full py-3 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Send Reset Link <ArrowRight className="h-4 w-4" /></>}
          </button>
        </form>
      )}
    </CardWrapper>
  );
}
