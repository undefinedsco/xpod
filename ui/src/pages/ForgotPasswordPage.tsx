import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { AuthSurface, Button, PasswordRecoveryView } from '@undefineds.co/shared-ui';
import { useAuth } from '../context/AuthContextValue';

export function ForgotPasswordPage() {
  const { controls, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }

  const submit = async (value: string) => {
    if (status === 'submitting') return;
    setStatus('submitting');
    setError(undefined);
    try {
      const response = await fetch(controls?.password?.forgot || '/.account/login/password/forgot/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: value.trim() }),
      });
      if (!response.ok) {
        // Keep account existence private: only transport/protocol failure is shown.
        setError(response.status === 429
          ? 'Too many requests. Please try again later.'
          : 'We could not send a reset link. Please try again.');
        setStatus('error');
        return;
      }
      setStatus('success');
    } catch {
      setError('We could not send a reset link. Please try again.');
      setStatus('error');
    }
  };

  return (
    <AuthSurface mode="page" title="Recover your password">
      <div className="space-y-4 p-4">
        <PasswordRecoveryView
          email={email}
          onEmailChange={(value) => {
            setEmail(value);
            setError(undefined);
            if (status === 'error') setStatus('idle');
          }}
          onSubmit={submit}
          pending={status === 'submitting'}
          status={status}
          error={error}
          copy={{
            title: 'Reset password',
            description: 'We will send a reset link if the email is registered.',
            emailLabel: 'Email',
            emailPlaceholder: 'you@example.com',
            actionLabel: 'Send reset link',
            successTitle: 'Check your inbox',
            successMessage: "If that email exists, we've sent a reset link.",
          }}
        />
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={() => navigate('/.account/login/password/')}>
            Back to sign in
          </Button>
          {status === 'success' ? (
            <Button type="button" className="flex-1" onClick={() => { setStatus('idle'); setError(undefined); }}>
              Resend
            </Button>
          ) : null}
        </div>
      </div>
    </AuthSurface>
  );
}
