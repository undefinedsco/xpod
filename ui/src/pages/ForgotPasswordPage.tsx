import { scopeAccountUrl } from '../utils/account-interaction-url';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { useState } from 'react';
import { useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import { Button } from '@undefineds.co/shared-ui';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';
import { PasswordRecoveryView } from '../auth/XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import {
  safeXpodRecoveryMessage,
  xpodAccountPageCopy,
  xpodPasswordRecoveryCopy,
} from '../auth/xpod-account-copy';

export function ForgotPasswordPage() {
  const { controls, idpIndex, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  const returnTo = searchParams.get('returnTo');
  const loginSearch = returnTo ? `?${new URLSearchParams({ returnTo })}` : '';

  if (isLoggedIn) {
    return <Navigate to={scopeAccountUrl("/.account/account/")} replace />;
  }

  const submit = async (value: string) => {
    if (status === 'submitting') return;
    setStatus('submitting');
    setError(undefined);
    try {
      const endpoint = await resolveHostedAccountControlUrl(
        controls?.password?.forgot || '/.account/login/password/forgot/', fetch, idpIndex,
      );
      if (!endpoint) throw new Error('Account recovery control unavailable');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: value.trim() }),
      });
      if (!response.ok) {
        // Keep account existence private: only transport/protocol failure is shown.
        setError(safeXpodRecoveryMessage(response.status));
        setStatus('error');
        return;
      }
      setStatus('success');
    } catch {
      setError(safeXpodRecoveryMessage());
      setStatus('error');
    }
  };

  return (
    <XpodAccountPageSurface
      title={xpodAccountPageCopy.recoverSurfaceTitle}
    >
      <div className="flex h-full min-h-0 flex-1 flex-col justify-center px-5 pb-5 pt-4">
        <p className="mb-4 text-sm leading-5 text-muted-foreground">
          {xpodPasswordRecoveryCopy.description}
        </p>
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
          copy={xpodPasswordRecoveryCopy}
          frame="bare"
          showHeader={false}
        />
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={() => navigate({ pathname: scopeAccountUrl('/.account/login/password/'), search: loginSearch })}>
            {xpodAccountPageCopy.backToSignIn}
          </Button>
          {status === 'success' ? (
            <Button type="button" className="flex-1" onClick={() => { setStatus('idle'); setError(undefined); }}>
              {xpodAccountPageCopy.resend}
            </Button>
          ) : null}
        </div>
      </div>
    </XpodAccountPageSurface>
  );
}
