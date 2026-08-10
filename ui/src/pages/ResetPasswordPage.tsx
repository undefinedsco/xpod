import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthSurface, Button, PasswordResetView } from '@undefineds.co/shared-ui';
import { useAuth } from '../context/AuthContextValue';

export function ResetPasswordPage() {
  const { controls, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const recordId = searchParams.get('rid') || searchParams.get('token');

  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }
  if (!recordId) {
    return <Navigate to="/.account/login/password/forgot/" replace />;
  }

  const submit = async (values: { password: string; confirmation: string }) => {
    if (status === 'submitting') return;
    setStatus('submitting');
    setError(undefined);
    try {
      const response = await fetch(controls?.password?.reset || '/.account/login/password/reset/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recordId, password: values.password }),
      });
      if (!response.ok) {
        setError(response.status === 400 || response.status === 404
          ? 'This reset link is invalid or expired.'
          : 'We could not reset your password. Please try again.');
        setStatus('error');
        return;
      }
      setStatus('success');
    } catch {
      setError('We could not reset your password. Please try again.');
      setStatus('error');
    }
  };

  return (
    <AuthSurface mode="page" title="Reset your password">
      <div className="space-y-4 p-4">
        <PasswordResetView
          password={password}
          confirmation={confirmation}
          onPasswordChange={(value) => { setPassword(value); setError(undefined); }}
          onConfirmationChange={(value) => { setConfirmation(value); setError(undefined); }}
          onSubmit={submit}
          pending={status === 'submitting'}
          status={status}
          error={error}
          copy={{
            title: 'Set a new password',
            description: 'Choose a new password for your account.',
            passwordLabel: 'New password',
            passwordPlaceholder: 'Enter a new password',
            confirmationLabel: 'Confirm password',
            confirmationPlaceholder: 'Enter it again',
            actionLabel: 'Reset password',
            successMessage: 'Your password has been reset successfully.',
            mismatchError: 'Passwords do not match',
          }}
        />
        <Button type="button" variant="ghost" className="w-full" onClick={() => navigate('/.account/login/password/')}>
          Back to sign in
        </Button>
      </div>
    </AuthSurface>
  );
}
