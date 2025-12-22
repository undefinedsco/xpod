import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, ArrowRight, Loader2, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';

export function ForgotPasswordPage() {
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
    <CardWrapper title="Reset Password" subtitle="We will send a reset link to your email." icon={Mail} showBack onBack={() => navigate('../')}>
      {sent ? (
        <div className="space-y-4">
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
            <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
              <Check className="w-5 h-5 text-green-500" />
            </div>
            <p className="text-xs text-zinc-300">If that email exists, we've sent a reset link.</p>
          </div>
          <button onClick={() => navigate('../')} className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm font-medium">
            Back to Sign in
          </button>
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
