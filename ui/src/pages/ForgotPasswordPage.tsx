import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { AuthSurface, Button } from '@undefineds.co/shared-ui';
import { PasswordRecoveryView } from '../auth/XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { getXpodAuthSurfaceHost, isXpodDesktopHost } from '../auth/xpod-auth-surface-host';
import { XpodLoginBrand } from '../auth/XpodLoginBrand';
import {
  safeXpodRecoveryMessage,
  xpodAccountPageCopy,
  xpodPasswordRecoveryCopy,
} from '../auth/xpod-account-copy';

export function ForgotPasswordPage() {
  const { controls, isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const host = getXpodAuthSurfaceHost();
  const presentation = isXpodDesktopHost(globalThis.xpodDesktop) ? 'compact' : 'standard';

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
    <AuthSurface
      mode="page"
      title={xpodAccountPageCopy.recoverSurfaceTitle}
      presentation={presentation}
      host={host}
      lead={presentation === 'compact' ? <XpodLoginBrand compact /> : undefined}
    >
      <div className={presentation === 'compact'
        ? 'flex h-full min-h-0 flex-1 flex-col justify-center px-5 pb-5 pt-4'
        : 'space-y-4 p-4'}
      >
        {presentation !== 'compact' && xpodPasswordRecoveryCopy.description ? (
          <p className="text-sm text-muted-foreground">{xpodPasswordRecoveryCopy.description}</p>
        ) : null}
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
        <div className={presentation === 'compact' ? 'mt-3 flex gap-2' : 'flex gap-2'}>
          <Button type="button" variant="outline" className="flex-1" onClick={() => navigate('/.account/login/password/')}>
            {xpodAccountPageCopy.backToSignIn}
          </Button>
          {status === 'success' ? (
            <Button type="button" className="flex-1" onClick={() => { setStatus('idle'); setError(undefined); }}>
              {xpodAccountPageCopy.resend}
            </Button>
          ) : null}
        </div>
      </div>
    </AuthSurface>
  );
}
