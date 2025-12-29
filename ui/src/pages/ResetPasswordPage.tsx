import { useState } from 'react';
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { Lock, ArrowRight, Loader2, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';

export function ResetPasswordPage() {
  const { controls, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const recordId = searchParams.get('rid');
  const passwordsMatch = password.length > 0 && confirmPassword.length > 0 && password === confirmPassword;

  // If already logged in, redirect to dashboard
  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }

  // If no record ID, redirect to forgot password
  if (!recordId) {
    return <Navigate to="/.account/login/password/forgot/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passwordsMatch) {
      setError('Passwords do not match');
      return;
    }
    
    setIsLoading(true);
    setError(null);

    try {
      const resetUrl = controls?.password?.reset || '/.account/login/password/reset/';
      const res = await fetch(resetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recordId, password }),
      });

      if (res.ok) {
        setSuccess(true);
      } else {
        const json = await res.json().catch(() => ({}));
        setError(json.message || 'Failed to reset password');
      }
    } catch {
      setError('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <CardWrapper title="Reset Password" subtitle="Enter your new password." icon={Lock}>
      {success ? (
        <div className="space-y-4">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
            <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Check className="w-5 h-5 text-emerald-600" />
            </div>
            <p className="text-xs text-zinc-600">Your password has been reset successfully.</p>
          </div>
          <button onClick={() => navigate('/.account/login/password/')} className="w-full py-3 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-sm font-medium">
            Go to Sign in
          </button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-red-600 text-[11px]">
              {error}
            </div>
          )}
          <div className="space-y-3">
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <input
                name="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full pl-10 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm placeholder:text-zinc-400 focus:border-[#7C4DFF] focus:outline-none"
                placeholder="New password"
              />
            </div>
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
                className={`block w-full pl-10 pr-4 py-2.5 bg-zinc-50 border rounded-xl text-sm placeholder:text-zinc-400 focus:outline-none transition-colors ${
                  passwordsMatch ? "border-emerald-300 focus:border-emerald-500" : "border-zinc-200 focus:border-[#7C4DFF]"
                }`}
                placeholder="Confirm new password"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={isLoading || !passwordsMatch}
            className="w-full py-3 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Reset Password <ArrowRight className="h-4 w-4" /></>}
          </button>
          <div className="text-center">
            <button type="button" onClick={() => navigate('/.account/login/password/')} className="text-[11px] text-[#7C4DFF] hover:text-[#6B3FE8]">
              Back to Sign in
            </button>
          </div>
        </form>
      )}
    </CardWrapper>
  );
}
