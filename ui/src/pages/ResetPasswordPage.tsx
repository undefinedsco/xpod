import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@undefineds.co/shared-ui';
import { XpodAuthSurface } from '../auth/XpodAuthSurface';
import { PasswordResetView } from '../auth/XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { XpodLoginBrand } from '../auth/XpodLoginBrand';
import {
  safeXpodResetMessage,
  xpodAccountPageCopy,
  xpodPasswordResetCopy,
} from '../auth/xpod-account-copy';

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
        setError(safeXpodResetMessage(response.status));
        setStatus('error');
        return;
      }
      setStatus('success');
    } catch {
      setError(safeXpodResetMessage());
      setStatus('error');
    }
  };

  return (
    <XpodAuthSurface
      mode="page"
      title={xpodAccountPageCopy.resetSurfaceTitle}
      lead={<XpodLoginBrand compact />}
    >
      <div className="flex h-full min-h-0 flex-1 flex-col justify-center px-5 pb-5 pt-4">
        <p className="mb-4 text-sm leading-5 text-muted-foreground">
          {xpodPasswordResetCopy.description}
        </p>
        <PasswordResetView
          password={password}
          confirmation={confirmation}
          onPasswordChange={(value) => { setPassword(value); setError(undefined); }}
          onConfirmationChange={(value) => { setConfirmation(value); setError(undefined); }}
          onSubmit={submit}
          pending={status === 'submitting'}
          status={status}
          error={error}
          copy={xpodPasswordResetCopy}
          frame="bare"
          showHeader={false}
        />
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full"
          onClick={() => navigate('/.account/login/password/')}
        >
          {xpodAccountPageCopy.backToSignIn}
        </Button>
      </div>
    </XpodAuthSurface>
  );
}
